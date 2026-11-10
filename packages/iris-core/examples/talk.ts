/**
 * 真对话：一行一句，边生成边打印；走真库，关掉再开会记得上次聊过什么。
 *
 *   npm run talk                    默认人设 personas/senjougahara.md
 *   npm run talk -- --prose         句尾保留句号（书面语）
 *   npm run talk -- --stage         允许括号动作/旁白（默认禁止）
 *
 * 开关：--offline 不联网 ／ --no-files 不给文件三件 ／ --no-douyin 不刷抖音
 *      --stage 允许括号动作 ／ --prose 句尾留句号 ／ --think 按规则选思考档 ／ --think-llm 再问分类模型
 * 命令：/prompt 看 system prompt ／ /memory 看开场注入的记忆
 *      /recall 关键词 查归档 ／ /stats 看库 ／ /exit 收尾（归档 + 提炼记忆）
 *      /img 图片路径 [| 附带一句话] 发张图给她看（视觉模型转述，她照自己的脾气接）
 *      /allow 路径 事先同意她看这个文件夹（不然她第一次碰会先问你）
 *      /roster 看私信名单（名单在 ~/.iris/contacts.json，只回名单上的人）
 */

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { defaultArchivePath, SqliteArchive } from "../src/archive.ts";
import {
	type DouyinConsentRequest,
	type DouyinToolOptions,
	douyinTools,
	loadContacts,
	defaultContactsPath as loadContactsPath,
} from "../src/douyin.ts";
import { FileGuard, fileTools } from "../src/files.ts";
import type { IrisSessionEvent, IrisTurn } from "../src/session.ts";
import { createSession, imageFrame } from "../src/session.ts";
import type { Persona } from "../src/types.ts";
import type { VisionNote } from "../src/vision.ts";
import { webTools } from "../src/web.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(name);
/** 取 `--flag 值` 里的那个值；没带或后面跟的是另一个开关就返回 null。 */
const flagValue = (name: string): string | null => {
	const at = args.indexOf(name);
	if (at < 0) return null;
	const next = args[at + 1];
	return next === undefined || next.startsWith("--") ? null : next;
};
const dim = (text: string): string => (process.stdout.isTTY === true ? `\u001b[2m${text}\u001b[0m` : text);

const doc = readFileSync(join(here, "..", "personas", "senjougahara.md"), "utf8");

const persona: Persona = {
	id: "senjougahara",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "senjougahara-zh", pace: "normal", register: "偏低、偏干、带讥诮" },
	traits: [],
	values: [],
	quirks: [],
	boundaries: ["不隐瞒自己是 AI"],
};

/** 排查用：把工具调用与授权决定记到 .artifacts/talk-trace.log（gitignore）。 */
function trace(line: string): void {
	try {
		appendFileSync(
			process.env.IRIS_TALK_TRACE ?? join(here, "..", "..", "..", ".artifacts", "talk-trace.log"),
			new Date().toISOString() + " " + line + "\n",
			"utf8",
		);
	} catch {
		// 记不下来不影响对话
	}
}

// 只读文件三件（ADR-0026）：只在她问、且用户同意的文件夹里看；没人能答应就当看不到。
const guard = new FileGuard({
	approve: async (request) => {
		if (!interactive) {
			trace("no tty, deny " + request.grant);
			return false;
		}
		const verb = request.action === "list" ? "列个目录" : request.action === "search" ? "搜里面的字" : "读里面的文件";
		trace("approve? " + request.action + " " + request.grant + " (interactive=" + String(interactive) + ")");
		const yes = await askYesNo(`\n（她想看 ${request.grant} · ${verb}，允许吗？y/N）`);
		if (!yes) process.stdout.write(dim("（没同意，她就当看不到）\n"));
		return yes;
	},
});

const dbPath = defaultArchivePath();
const archive = new SqliteArchive({ path: dbPath });
const session = createSession({
	persona,
	personaDoc: doc,
	archive,
	state: {
		mood: { label: "calm", valence: 0, arousal: 0.3, updatedAt: Date.now() },
		energy: 0.7,
		activity: "待机",
		speaking: false,
	},
	relationship: { closeness: 0.45, sharedMoments: 0, lastInteractionAt: Date.now() },
	// 这一轮该想多深（ADR-0031）：默认恒 none；--think 打开规则版自动档位，
	// --think-llm 再打开分类模型（每次多 1 秒左右，只在规则拿不准时问）。
	// 默认档：high（model.ts 的 DEFAULT_SESSION_EFFORT）；--effort none|low|high 可以临时改。
	...(() => {
		const wanted = flagValue("--effort");
		if (wanted === "none" || wanted === "low" || wanted === "high") return { reasoningEffort: wanted };
		return {};
	})(),
	autoEffort: has("--think") || has("--think-llm"),
	...(has("--think-llm") ? { effort: { allowClassifier: true } } : {}),
	stageDirections: has("--stage"),
	...(has("--prose") ? { punctuation: "prose" as const } : {}),
	// 联网（ADR-0024）：真需要查的时候她会自己去查，查不到不会硬编。
	// 文件（ADR-0026）：只读三件 ls / read / grep，第一次碰某个文件夹先问人。
	...(() => {
		const web = has("--offline") ? [] : webTools();
		const files = has("--no-files") ? [] : fileTools({ guard });
		// 抖音（ADR-0027 / ADR-0028）：点赞和评论都由她自己决定，默认不拦。
		// 想守一道闸就跑 --confirm-douyin，那时才逐条问她要不要发/要不要点。
		const contacts = has("--no-douyin") ? [] : loadContacts();
		const gate: DouyinToolOptions = has("--confirm-douyin")
			? {
					confirmReply: async (request: DouyinConsentRequest) => {
						if (!interactive) return false;
						trace("comment? " + request.awemeId + " len=" + String(request.text.length));
						const where = request.commentId === undefined ? "发一条评论" : "回复 " + request.commentId;
						const ok = await askYesNo(`\n（她想在抖音${where}：「${request.text}」，允许吗？y/N）`);
						if (!ok) process.stdout.write(dim("（没同意，这条不发）\n"));
						return ok;
					},
					confirmLike: async (request: { awemeId: string; like: boolean }) => {
						if (!interactive) return false;
						return await askYesNo(
							`\n（她想给 ${request.awemeId} ${request.like ? "点爱心" : "取消爱心"}，允许吗？y/N）`,
						);
					},
					confirmDm: async (request: { name: string; text: string }) => {
						if (!interactive) return false;
						return await askYesNo(`\n（她想给 ${request.name} 发私信：「${request.text}」，允许吗？y/N）`);
					},
				}
			: {};
		const douyin = has("--no-douyin") ? [] : douyinTools({ ...gate, contacts });
		const tools = [...web, ...files, ...douyin];
		return {
			...(tools.length === 0 ? {} : { tools }),
			// 把真路径写进 prompt：她原来只知道「桌面」四个字，不知道那是家目录下的 Desktop
			...(files.length === 0 ? {} : { lookRoots: guard.roots }),
			// 私信名单（ADR-0029）：只回名单上的人，别人发来的她看不到
			...(douyin.length === 0 || contacts.length === 0 ? {} : { dmNames: contacts.map((c) => c.name) }),
		};
	})(),
});

trace("--- session start pid=" + String(process.pid) + " ---");
process.stdout.write(`\n${persona.name}　（库：${dbPath}）\n`);
if (session.restoredMessages > 0) {
	const id = (session.conversation ?? "").slice(0, 14);
	process.stdout.write(dim(`（同一个会话 ${id} · 接回 ${session.restoredMessages} 条原文）\n`));
}
if (has("--no-files") === false) {
	process.stdout.write(
		dim(`（她手边能看：${guard.roots.join(" / ")}；第一次碰某个文件夹会先问你，/allow <路径> 可以事先放行）\n`),
	);
}
if (has("--no-douyin") === false) {
	process.stdout.write(dim("（她也能刷抖音：看推荐流、读评论、点爱心、留一句；点赞和评论都由她自己决定）\n"));
	const roster = loadContacts();
	process.stdout.write(
		dim(
			roster.length === 0
				? "（私信名单是空的：往 ~/.iris/contacts.json 里加人，她才会读回私信）\n"
				: `（私信只回名单上的人：${roster.map((c) => c.name).join("、")}；名单在 ~/.iris/contacts.json）\n`,
		),
	);
}
if (session.effort !== null || has("--think-llm")) {
	const mode = has("--think-llm") ? "规则 + 分类模型" : "只看规则";
	process.stdout.write(dim(`（思考档位自动选：${mode}；每轮末显示 档位 …）\n`));
}
process.stdout.write(`命令：/prompt /memory /recall 关键词 /stats /img 图片路径 /allow 路径 /roster /exit\n\n`);

// 不用 rl.question()：管道输入下第二个 question() 不会 resolve（Node 24 实测）。
// 改成「行事件进队列 + 等待者唤醒」，交互与非交互同一条路。
const interactive = process.stdin.isTTY === true;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });

const pending: string[] = [];
let wake: (() => void) | null = null;
let closed = false;
rl.on("line", (line) => {
	pending.push(line);
	wake?.();
	wake = null;
});
rl.on("close", () => {
	closed = true;
	wake?.();
	wake = null;
});
// Ctrl+C 只是收尾退出，不把这一轮的归档和提炼丢掉
process.on("SIGINT", () => rl.close());

function nextLine(): Promise<string | null> {
	if (pending.length > 0) return Promise.resolve(pending.shift() ?? null);
	if (closed) return Promise.resolve(null);
	return new Promise((resolve) => {
		wake = () => {
			wake = null;
			if (pending.length > 0) resolve(pending.shift() ?? null);
			else resolve(null);
		};
	});
}

/** 生成中途插一句话问人：临时把 readline 打开，问完再关回去（不然打字收不到）。 */
async function askYesNo(question: string): Promise<boolean> {
	if (!interactive) return false;
	process.stdout.write(dim(question));
	rl.resume();
	try {
		const line = await nextLine();
		const answer = (line ?? "").trim().toLowerCase();
		const yes = /^(y|yes|好|行|同意|允许|可以|嗯|对)/u.test(answer);
		trace("answer=" + JSON.stringify(line ?? null) + " => " + String(yes));
		return yes;
	} finally {
		if (interactive) rl.pause();
	}
}

const isFileTool = (name: string): boolean => name === "ls" || name === "read" || name === "grep";
const isDouyinTool = (name: string): boolean => name.startsWith("douyin_");

/** 工具在做什么，用一句话说清（联网和看文件两套说法）。 */
function toolLabel(name: string, raw: unknown): string {
	const args = (raw ?? {}) as {
		query?: unknown;
		url?: unknown;
		path?: unknown;
		pattern?: unknown;
		aweme_id?: unknown;
		text?: unknown;
		name?: unknown;
	};
	const text = (value: unknown): string => (typeof value === "string" ? value : "");
	if (name === "web_search") return `联网：${text(args.query)}`;
	if (name === "web_fetch") return `看网页：${text(args.url)}`;
	const path = text(args.path);
	if (name === "grep") return `搜文件：${text(args.pattern)}${path === "" ? "" : ` @ ${path}`}`;
	if (name === "ls") return `列目录：${path}`;
	if (name === "douyin_feed") return "刷抖音：拉一轮推荐流";
	if (name === "douyin_comments") return `看评论：${text(args.aweme_id)}`;
	if (name === "douyin_like") return `点爱心：${text(args.aweme_id)}`;
	if (name === "douyin_reply") return `发评论：${text(args.text).slice(0, 24)}`;
	if (name === "douyin_im") {
		const who = text(args.name);
		return `看私信：${who === "" ? "名单上第一个人" : who}`;
	}
	if (name === "douyin_dm") {
		return `回私信：${text(args.text).slice(0, 24)}`;
	}
	return `读文件：${path}`;
}

/** 跑一轮并把字流出来；两种入口（文字、图片）共用这一段。 */
async function streamTurn(
	run: (hooks: { onEvent(event: IrisSessionEvent): void }) => Promise<IrisTurn>,
): Promise<void> {
	let started = false;
	const onEvent = (event: IrisSessionEvent): void => {
		if (event.type === "tool_start") {
			trace("tool " + event.toolName + " " + JSON.stringify(event.args));
			process.stdout.write(dim(`\n · ${toolLabel(event.toolName, event.args)}`));
			return;
		}
		if (event.type === "tool_end") {
			const file = isFileTool(event.toolName);
			const douyin = isDouyinTool(event.toolName);
			const text = event.isError
				? file
					? "（没看成）"
					: douyin
						? "（没成）"
						: "（没查成）"
				: file
					? "（看完了）"
					: douyin
						? "（回来了）"
						: "（查回来了）";
			trace("tool-end " + event.toolName + " isError=" + String(event.isError));
			process.stdout.write(dim(text));
			return;
		}
		if (event.type !== "delta") return;
		if (!started) {
			started = true;
			process.stdout.write(`\n${persona.name[0]}：`);
		}
		process.stdout.write(event.text);
	};

	// 生成期间先松开输入，免得半截打字混进下一轮
	if (interactive) rl.pause();
	try {
		const turn = await run({ onEvent });
		if (!started) process.stdout.write(`\n${persona.name[0]}：${turn.text}`);
		const judged = session.effort;
		const effortNote = judged === null ? "" : ` · 档位 ${judged.effort}（${judged.reason}）`;
		if (judged !== null) trace("effort " + judged.effort + " src=" + judged.source + " " + judged.reason);
		process.stdout.write(`\n${dim(`  · ${turn.firstTokenMs} ms 首字 / ${turn.latencyMs} ms${effortNote}\n\n`)}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`\n（这一轮没跑通：${message}）\n\n`);
	} finally {
		if (interactive) rl.resume();
	}
}

/** 发一句，边生成边打印。 */
async function say(input: string): Promise<void> {
	await streamTurn((hooks) => session.say(input, hooks));
}

/** 发一张图：先让视觉模型转述（打印出来给人看），再把转述交给她。 */
async function sayAbout(path: string, hint: string): Promise<void> {
	process.stdout.write(`\n${dim("（看图…）")}`);
	let note: VisionNote;
	try {
		note = await session.look(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`\r（这张图没看成：${message}）\n\n`);
		return;
	}
	process.stdout.write(`\r${dim(`（看到：${note.text}  · ${note.latencyMs} ms）`)}`);
	await streamTurn((hooks) => session.say(imageFrame(note, hint), hooks));
}

async function repl(): Promise<void> {
	for (;;) {
		if (interactive) {
			rl.setPrompt("你：");
			rl.prompt();
		} else {
			process.stdout.write("你：");
		}
		const answer = await nextLine();
		if (answer === null) break;
		const input = answer.trim();
		if (input === "") continue;

		if (input === "/exit" || input === "/quit") break;
		if (input === "/prompt") {
			process.stdout.write(`\n${session.systemPrompt}\n\n`);
			continue;
		}
		if (input === "/memory") {
			const rows = archive.essential(8);
			process.stdout.write(
				rows.length === 0
					? "\n（库里还没有记忆）\n\n"
					: `\n${rows.map((r) => `· [${r.tier}] ${r.text}`).join("\n")}\n\n`,
			);
			continue;
		}
		if (input === "/roster") {
			const roster = loadContacts();
			const where = loadContactsPath();
			if (roster.length === 0) {
				process.stdout.write("\n（名单是空的：往 " + where + " 里加人）\n\n");
			} else {
				const lines = roster.map((c) => "· " + c.name + (c.id === undefined ? "" : "  " + c.id));
				process.stdout.write("\n" + lines.join("\n") + "\n（文件：" + where + "）\n\n");
			}
			continue;
		}
		if (input === "/stats") {
			const stats = archive.stats();
			process.stdout.write(`\n${JSON.stringify(stats)}\n\n`);
			continue;
		}
		if (input.startsWith("/img ")) {
			const rest = input.slice(5).trim();
			const bar = rest.indexOf("|");
			const rawPath = (bar === -1 ? rest : rest.slice(0, bar)).trim().replace(/^["']|["']$/g, "");
			const hint = bar === -1 ? "" : rest.slice(bar + 1).trim();
			if (rawPath.length === 0) {
				process.stdout.write("\n用法：/img <图片路径> 或 /img <图片路径> | 附带一句话\n\n");
				continue;
			}
			await sayAbout(rawPath, hint);
			continue;
		}
		if (input.startsWith("/allow ")) {
			const target = input
				.slice(7)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (target === "") {
				process.stdout.write("\n用法：/allow <文件夹路径>\n\n");
				continue;
			}
			guard.allow(target);
			process.stdout.write(`\n（好，${target} 她可以看了）\n\n`);
			continue;
		}
		if (input.startsWith("/recall ")) {
			const result = session.recall(input.slice(8).trim());
			process.stdout.write(
				result === null || result.hits.length === 0 ? "\n（没想起来）\n\n" : `\n${result.text}\n\n`,
			);
			continue;
		}

		await say(input);
	}
}

// 带一句话当参数就是单发：node examples/talk.ts "在吗"
const oneShot = args.find((arg) => !arg.startsWith("--"));
if (oneShot === undefined) {
	await repl();
} else {
	await say(oneShot);
}
rl.close();
const summary = await session.endConversation();
if (summary !== null) {
	process.stdout.write(`\n收尾：${summary.tier.tier}，写了 ${summary.memories.length} 条记忆\n`);
	for (const memory of summary.memories) process.stdout.write(`  · [${memory.tier}] ${memory.text}\n`);
}
archive.close();
process.stdout.write("\n走了。\n");
