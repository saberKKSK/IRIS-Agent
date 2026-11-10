/**
 * 真对话：一行一句，边生成边打印；走真库，关掉再开会记得上次聊过什么。
 *
 *   npm run talk                    默认人设 personas/senjougahara.md
 *   npm run talk -- --prose         句尾保留句号（书面语）
 *   npm run talk -- --stage         允许括号动作/旁白（默认禁止）
 *
 * 开关：--offline 不联网 ／ --no-files 不给文件三件 ／ --no-douyin 不刷抖音 ／ --no-shell 不给命令 ／ --no-screen 不给她看屏幕
 *      --no-watch 不让她自己一直盯着屏幕（默认 20 秒瞥一眼，画面变了才重新描述）／ --idle 秒数 多久没说话算「他没在跟我说话」
 *      --stage 允许括号动作 ／ --prose 句尾留句号 ／ --think 按规则选思考档 ／ --think-llm 再问分类模型
 * 命令：/prompt 看 system prompt ／ /memory 看开场注入的记忆
 *      /recall 关键词 查归档 ／ /stats 看库 ／ /exit 收尾（归档 + 提炼记忆）
 *      /img 图片路径 [| 附带一句话] 发张图给她看（视觉模型转述，她照自己的脾气接）
 *      /allow 路径 放开一个文件夹给她（记进 ~/.iris/file-roots.json，以后不再问）
 *      /forget 路径 收回放行 ／ /grants 看她现在能看哪些
 *      /write 路径 放开一个文件夹让她写（记进 ~/.iris/write-roots.json，写的账跟看的账分开）
 *      /unwrite 路径 收回写权限 ／ /writes 看她现在能写哪些
 *      /exec 看她记住哪些命令头（~/.iris/exec-allow.json）／ /unexec 命令头 取消一个
 *      /exec 看她记住哪些命令头（~/.iris/exec-allow.json）／ /unexec 命令头 取消一个
 *      /roster 看私信名单（名单在 ~/.iris/contacts.json，只回名单上的人）
 *      /look [问题] 你自己调一次她的眼睛（抓一张缩略图，只打印转述，不占对话回合）
 *      /watch 看她的眼睛现在看到什么、抓过几次、说过几次
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
import { defaultGrantsPath, FileGuard, fileTools } from "../src/files.ts";
import { LineQueue } from "../src/lines.ts";
import { ScreenWatcher } from "../src/perception.ts";
import { captureScreen, screenTools } from "../src/screen.ts";
import type { IrisSessionEvent, IrisTurn } from "../src/session.ts";
import { createSession, imageFrame } from "../src/session.ts";
import { defaultShellAllowPath, ShellGuard, shellTools } from "../src/shell.ts";
import type { Persona } from "../src/types.ts";
import { describeImage, loadImage, type VisionNote } from "../src/vision.ts";
import { webTools } from "../src/web.ts";
import { defaultWriteGrantsPath, WriteGuard, writeTools } from "../src/write.ts";

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

// 只读文件（ADR-0026 / ADR-0033）：默认只看得见他放开的文件夹。
// 放开的记在 ~/.iris/file-roots.json，一次点头管一辈子；没放开时她会自己开口要。
const guard = new FileGuard({
	grantsFile: defaultGrantsPath(),
	approve: (request) =>
		// 两个工具可能同时来问，串起来问，别让两句话叠在一起（曾经因此挂死过）
		serialized(async () => {
			if (!interactive) {
				trace("no tty, deny " + request.grant);
				return false;
			}
			const verb =
				request.action === "list" ? "列个目录" : request.action === "search" ? "搜里面的字" : "读里面的文件";
			const why = request.reason === undefined ? "" : `，她说：${request.reason}`;
			const where = request.root;
			trace("approve? " + request.action + " " + request.grant + " (interactive=" + String(interactive) + ")");
			const answer = await ask(
				`\n（她想看 ${request.grant} · ${verb}${why}）\n` +
					`（y = 就这次 / a = 以后 ${where} 整个都放给她 / N = 不给）：`,
			);
			const text = (answer ?? "").trim().toLowerCase();
			trace("answer=" + JSON.stringify(answer ?? null));
			if (/^a/u.test(text)) {
				guard.allow(where, { persist: true });
				process.stdout.write(dim(`（好，以后 ${where} 她随便看）\n`));
				return true;
			}
			const yes = /^(y|yes|好|行|同意|允许|可以|嗯|对)/u.test(text);
			if (!yes) process.stdout.write(dim("（没同意，她就当看不到）\n"));
			return yes;
		}),
});

// 写（ADR-0034）：能看不等于能写。写权限记在 ~/.iris/write-roots.json，默认什么都没有，
// 第一次碰某个文件夹她开口要，问一次就记住。没人能问就一律拒。
const writeGuard = new WriteGuard({
	grantsFile: defaultWriteGrantsPath(),
	approve: (request) =>
		serialized(async () => {
			if (!interactive) {
				trace("no tty, deny write " + request.grant);
				return false;
			}
			const verb =
				request.action === "append"
					? "往后加内容"
					: request.action === "mkdir"
						? "建文件夹"
						: request.action === "move"
							? "改名或搬家"
							: "写文件";
			const why = request.reason === undefined ? "" : "，她说：" + request.reason;
			const where = request.root;
			trace("write? " + request.action + " " + request.grant + " (interactive=" + String(interactive) + ")");
			const answer = await ask(
				"\n（她想往 " +
					request.grant +
					" 里" +
					verb +
					why +
					"）\n" +
					"（y = 就这次 / a = 以后 " +
					where +
					" 整个都放给她写 / N = 不给）：",
			);
			const text = (answer ?? "").trim().toLowerCase();
			trace("write-answer=" + JSON.stringify(answer ?? null));
			if (/^a/u.test(text)) {
				writeGuard.allow(where, { persist: true });
				process.stdout.write(dim("（好，以后 " + where + " 她随便写）\n"));
				return true;
			}
			const yes = /^(y|yes|好|行|同意|允许|可以|嗯|对)/u.test(text);
			if (!yes) process.stdout.write(dim("（没同意，她就不写）\n"));
			return yes;
		}),
});

// 跑命令（ADR-0035）：地方沿用写的那本账（只在她能写的文件夹里跑），
// 内容分两档：一看就是只读的命令（ls / cat / git status）直接跑，其余每一条都问人。
// 被同意过的命令头可以记住（~/.iris/exec-allow.json，按 a 就记）；危险命令永远逐条问，不记。
const shellGuard = new ShellGuard({
	grants: () => writeGuard.grants,
	allowFile: defaultShellAllowPath(),
	approve: (request) =>
		serialized(async () => {
			if (!interactive) {
				trace("no tty, deny shell " + request.command);
				return false;
			}
			trace("run? " + request.command + " @ " + request.cwd);
			const answer = await ask(
				"\n（她想在 " +
					request.cwd +
					" 里跑：「" +
					request.command +
					"」）\n" +
					"（y = 就这次 / a = 以后 " +
					request.head +
					" 这个命令都放给她 / N = 不跑）：",
			);
			const text = (answer ?? "").trim().toLowerCase();
			trace("run-answer=" + JSON.stringify(answer ?? null));
			if (/^a/u.test(text)) {
				shellGuard.remember(request.head);
				process.stdout.write(dim("（好，以后 " + request.head + " 这个命令不用再问你）\n"));
				return true;
			}
			const yes = /^(y|yes|好|行|同意|允许|可以|嗯|对)/u.test(text);
			if (!yes) process.stdout.write(dim("（没同意，这条不跑）\n"));
			return yes;
		}),
});
// 感知层（ADR-0037）：她自己隔一会儿瞥一眼屏幕，变了才让视觉模型重新描述。
// 关掉看屏幕（--no-screen）或 --no-watch 就不起这个循环。
const watcher: ScreenWatcher | null =
	has("--no-screen") || has("--no-watch")
		? null
		: new ScreenWatcher({
				onNote: (seen) => trace("watch note " + String(seen.note.length) + " chars"),
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
	...(watcher === null ? {} : { perception: () => watcher.noteFor() }),
	// 联网（ADR-0024）：真需要查的时候她会自己去查，查不到不会硬编。
	// 文件（ADR-0026）：只读三件 ls / read / grep，第一次碰某个文件夹先问人。
	...(() => {
		const web = has("--offline") ? [] : webTools();
		const files = has("--no-files") ? [] : fileTools({ guard });
		// 写（ADR-0034）：五件是 write_file / append_file / make_dir / move_path / request_write。
		// reads 传只读那把守门人：覆盖已有文件之前她必须这次进程里 read 过它。
		const writes = has("--no-write") ? [] : writeTools({ guard: writeGuard, reads: guard });
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
		// 命令（ADR-0035）：一件 run_command，地方跟着写权限走。
		const shell = has("--no-shell") ? [] : shellTools({ guard: shellGuard });
		// 屏幕（ADR-0036）：一件 look_at_screen，抓缩略图交给视觉模型转述。
		// 不设闸：他让她看屏幕，本来就是他自己叫的；--no-screen 可以整套关掉。
		const screen = has("--no-screen") ? [] : screenTools();
		const tools = [...web, ...files, ...writes, ...douyin, ...shell, ...screen];
		return {
			...(tools.length === 0 ? {} : { tools }),
			// 把真路径写进 prompt：她原来只知道「桌面」四个字，不知道那是家目录下的 Desktop；
			// 他放开过的文件夹（可能在家目录外面）也要算进来，否则她会说「我只有家目录」
			...(files.length === 0 ? {} : { lookRoots: [...new Set([...guard.roots, ...guard.storedGrants])] }),
			// 能写的地方（跟能看的分开记）
			...(writes.length === 0 ? {} : { writeRoots: [...writeGuard.grants] }),
			// 私信名单（ADR-0029）：只回名单上的人，别人发来的她看不到
			...(shell.length === 0 ? {} : { shellRoots: [...shellGuard.grants] }),
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
	const open = guard.storedGrants;
	process.stdout.write(
		dim(
			open.length === 0
				? `（她手边能看：${guard.roots.join(" / ")}；还没放开任何文件夹，她要看时问你，按 a 就是以后都放开）\n`
				: `（她已经能看：${open.join(" / ")}；/grants 看全部，/allow <路径> 再放开一个）\n`,
		),
	);
}
if (has("--no-write") === false) {
	const writable = writeGuard.storedGrants;
	process.stdout.write(
		dim(
			writable.length === 0
				? "（她能写：" + writeGuard.roots.join(" / ") + " 下面，但要你点头；她要写时会问你，按 a 就是以后都放开）\n"
				: "（她已经能写：" + writable.join(" / ") + "；/writes 看全部，/write <路径> 再放开一个）\n",
		),
	);
}
if (has("--no-shell") === false) {
	const runnable = writeGuard.grants;
	process.stdout.write(
		dim(
			runnable.length === 0
				? "（她还没地方跑命令：先 /write 放开一个文件夹；只读命令直接跑，其余她会先问你）\n"
				: "（她能在 " +
						runnable.join(" / ") +
						" 里跑命令；ls / cat / git status 这类直接跑，其余先问你，按 a 记住这个命令）\n",
		),
	);
}
// 主动开口的阈值（ADR-0037）：他多久没说话才算空下来。
const idleMs = (() => {
	const raw = flagValue("--idle");
	const seconds = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 90_000;
})();
if (has("--no-screen") === false) {
	process.stdout.write(
		dim(
			watcher === null
				? "（她也能看你屏幕：抓一张缩略图交给视觉模型转述，一次 8 到 18 秒；/look [问题] 你自己调一次）\n"
				: "（她自己一直看着屏幕：每 20 秒瞥一眼，画面变了才重新描述（约 9 秒）；你超过 " +
						String(Math.round(idleMs / 1000)) +
						" 秒没说话、屏幕又变过，她会自己开口；/watch 看她的眼睛，/look [问题] 手动看一次）\n",
		),
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
process.stdout.write(
	`命令：/prompt /memory /recall 关键词 /stats /watch /img 图片路径 /look [问题] /grants /allow 路径 /forget 路径 /writes /write 路径 /unwrite 路径 /exec /unexec 命令头 /roster /exit\n\n`,
);

// 主动开口（ADR-0037）：他没在说话 + 屏幕有变化 + 冷却过了，就让她自己说一句。
// 「有变化」是必须的：屏幕一动不动时硬找话题，比不说话更像机器。
const SPEAK_COOLDOWN_MS = 5 * 60_000;
let lastUserAt = Date.now();
let lastSpokeAt = 0;
let speakingUp = false;

// 不用 rl.question()：管道输入下第二个 question() 不会 resolve（Node 24 实测）。
// 改成「行事件进队列 + 等待者唤醒」，交互与非交互同一条路。
const interactive = process.stdin.isTTY === true;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });

// 输入统一进队列（src/lines.ts）：两处同时等输入时谁都别被顶掉
const lines = new LineQueue();
rl.on("line", (line) => lines.push(line));
rl.on("close", () => lines.close());
// Ctrl+C 只是收尾退出，不把这一轮的归档和提炼丢掉
process.on("SIGINT", () => rl.close());

function nextLine(): Promise<string | null> {
	return lines.next();
}

/** 问人一句话，拿回原话：问权限要区分 y（这次）和 a（以后都行），光要真假不够。 */
async function ask(question: string): Promise<string | null> {
	if (!interactive) return null;
	process.stdout.write(dim(question));
	return await nextLine();
}

/** 只要真假答案的场合（抖音闸门）走这个。 */
async function askYesNo(question: string): Promise<boolean> {
	const answer = ((await ask(question + "（y/N）")) ?? "").trim().toLowerCase();
	const yes = /^(y|yes|好|行|同意|允许|可以|嗯|对)/u.test(answer);
	trace("answer=" + JSON.stringify(answer) + " => " + String(yes));
	return yes;
}

// 两件要问人的事同时发生（她一轮里并行 ls 两个文件夹）时排队问，别叠在一起。
let asking: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
	const run = asking.then(task, task);
	asking = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** 工具跑完那一格写什么字（按工具种类分，别都写「查回来了」）。 */
function endWord(kind: {
	file: boolean;
	write: boolean;
	douyin: boolean;
	shell: boolean;
	screen: boolean;
	isError: boolean;
}): string {
	if (kind.isError) {
		if (kind.file) return "（没看成）";
		if (kind.write) return "（没写成）";
		if (kind.douyin) return "（没成）";
		if (kind.shell) return "（没跑成）";
		if (kind.screen) return "（没看清）";
		return "（没查成）";
	}
	if (kind.file) return "（看完了）";
	if (kind.write) return "（写好了）";
	if (kind.douyin) return "（回来了）";
	if (kind.shell) return "（跑完了）";
	if (kind.screen) return "（看清了）";
	return "（查回来了）";
}

const isFileTool = (name: string): boolean => name === "ls" || name === "read" || name === "grep";
const isWriteTool = (name: string): boolean =>
	name === "write_file" || name === "append_file" || name === "make_dir" || name === "move_path";
const isDouyinTool = (name: string): boolean => name.startsWith("douyin_");
const isShellTool = (name: string): boolean => name === "run_command";
const isScreenTool = (name: string): boolean => name === "look_at_screen";

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
	if (name === "request_access") {
		const reason = text((raw as { reason?: unknown } | null)?.reason);
		return `要权限：${path}${reason === "" ? "" : `（${reason}）`}`;
	}
	if (name === "request_write") {
		const reason = text((raw as { reason?: unknown } | null)?.reason);
		return `要写权限：${path}${reason === "" ? "" : `（${reason}）`}`;
	}
	if (name === "write_file") return `写文件：${path}`;
	if (name === "append_file") return `往后加：${path}`;
	if (name === "make_dir") return `建文件夹：${path}`;
	if (name === "move_path") {
		const from = text((raw as { from?: unknown } | null)?.from);
		const to = text((raw as { to?: unknown } | null)?.to);
		return `改名搬家：${from} → ${to}`;
	}
	if (name === "run_command") return `跑命令：${text((raw as { command?: unknown } | null)?.command).slice(0, 60)}`;
	if (name === "look_at_screen") {
		const question = text((raw as { question?: unknown } | null)?.question);
		return `看屏幕${question === "" ? "" : `：${question.slice(0, 40)}`}`;
	}
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
	// 她常一轮并行调好几个工具：每条结果要落回自己那一行，不能都挤到最后一行
	// （曾经出现过「列目录：桌面（看完了）（看完了）」这种叠字）
	const labels = new Map<string, string>();
	let openCall: string | null = null;
	const onEvent = (event: IrisSessionEvent): void => {
		if (event.type === "tool_start") {
			const label = toolLabel(event.toolName, event.args);
			trace("tool " + event.toolName + " " + JSON.stringify(event.args));
			labels.set(event.toolCallId, label);
			process.stdout.write(dim(`\n · ${label}`));
			openCall = event.toolCallId;
			return;
		}
		if (event.type === "tool_end") {
			const label = labels.get(event.toolCallId);
			labels.delete(event.toolCallId);
			const file = isFileTool(event.toolName);
			const write = isWriteTool(event.toolName);
			const douyin = isDouyinTool(event.toolName);
			const shell = isShellTool(event.toolName);
			const screen = isScreenTool(event.toolName);
			const text =
				event.toolName === "request_access" || event.toolName === "request_write"
					? event.isError
						? "（他没给）"
						: "（他给了）"
					: endWord({ file, write, douyin, shell, screen, isError: event.isError });
			trace("tool-end " + event.toolName + " isError=" + String(event.isError));
			if (openCall === event.toolCallId) {
				process.stdout.write(dim(text) + "\n");
				openCall = null;
			} else if (event.isError && label !== undefined) {
				// 那一行已经被后面启动的工具顶掉了，单独补一行，别让她「没看成」却看不见
				process.stdout.write(dim(`\n · ${label}${text}\n`));
			}
			// 他刚放开一个新文件夹：立刻换 prompt，否则下一轮她还说「我只有家目录」
			if (event.toolName === "request_access" && !event.isError) {
				session.setLookRoots([...new Set([...guard.roots, ...guard.storedGrants])]);
			}
			// 同理，刚放开的写权限也要立刻反映到 prompt 里
			if (event.toolName === "request_write" && !event.isError) {
				session.setWriteRoots([...writeGuard.grants]);
				session.setShellRoots([...writeGuard.grants]);
			}
			return;
		}
		if (event.type !== "delta") return;
		if (!started) {
			started = true;
			process.stdout.write(`\n${persona.name[0]}：`);
		}
		process.stdout.write(event.text);
	};

	// 不暂停输入：生成期间打的字进队列，下一轮接着用（暂停会让等答案的人永远等不到）
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

/** 心跳：看她该不该自己开口。没把握就什么都不做。 */
async function heartbeat(): Promise<void> {
	if (watcher === null || speakingUp) return;
	if (session.isStreaming) return;
	const now = Date.now();
	if (now - lastUserAt < idleMs) return;
	if (lastSpokeAt !== 0 && now - lastSpokeAt < SPEAK_COOLDOWN_MS) return;
	// 屏幕没变过：他还在看同一页、我们也没什么新的可接，别硬开口
	if (watcher.changedSince(lastUserAt) === false) return;
	speakingUp = true;
	try {
		process.stdout.write(dim("\n（她自己开口）"));
		trace("speak-up");
		await streamTurn((hooks) => session.speakUp("", hooks));
		lastSpokeAt = Date.now();
		if (process.stdin.isTTY === true) {
			rl.setPrompt("你：");
			rl.prompt();
		}
	} catch {
		// 这一轮没跑通就算了，下一拍再说
	} finally {
		speakingUp = false;
	}
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
		lastUserAt = Date.now();

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
		if (input === "/watch") {
			if (watcher === null) {
				process.stdout.write("\n（没在看她屏幕：--no-screen 或 --no-watch 关着）\n\n");
			} else {
				const stats = watcher.stats;
				const note = watcher.noteFor();
				process.stdout.write(
					"\n· 瞥过 " +
						String(stats.ticks) +
						" 次，重新描述 " +
						String(stats.looks) +
						" 次\n" +
						(note === null ? "· 还没看到过东西\n" : "· 最近：" + note + "\n") +
						"· 她自己开口的冷却 " +
						String(Math.round(SPEAK_COOLDOWN_MS / 60_000)) +
						" 分钟，空闲 " +
						String(Math.round(idleMs / 1000)) +
						" 秒算「他没在说话」\n\n",
				);
			}
			continue;
		}
		if (input === "/stats") {
			const stats = archive.stats();
			process.stdout.write(`\n${JSON.stringify(stats)}\n\n`);
			continue;
		}
		if (input === "/look" || input.startsWith("/look ")) {
			const question = input.slice(5).trim();
			process.stdout.write(dim("\n（她正在看屏幕…）\n"));
			try {
				const frame = await captureScreen();
				const note = await describeImage(loadImage(frame.path), {
					...(question === "" ? {} : { prompt: question + "（就答这一句，三句以内，只说你看到的）" }),
				});
				process.stdout.write(
					dim(
						`（缩略 ${Math.round(frame.bytes / 1024)} KB · 抓 ${frame.ms} ms · 看 ${note.latencyMs} ms · 只看不改对话）\n`,
					),
				);
				process.stdout.write(`${note.text}\n\n`);
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				process.stdout.write(dim(`（没看成：${why}）\n\n`));
			}
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
			// 默认记进文件：他亲手放开的，就该一直算数，不用每次重来
			const grant = guard.allow(target, { persist: true });
			session.setLookRoots([...new Set([...guard.roots, ...guard.storedGrants])]);
			process.stdout.write(`\n（好，${grant} 她可以看了；记在 ${defaultGrantsPath()}，重启也算）\n\n`);
			continue;
		}
		if (input.startsWith("/write ")) {
			const target = input
				.slice(7)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (target === "") {
				process.stdout.write("\n用法：/write <文件夹路径>\n\n");
				continue;
			}
			const grant = writeGuard.allow(target, { persist: true });
			session.setWriteRoots([...writeGuard.grants]);
			session.setShellRoots([...writeGuard.grants]);
			process.stdout.write(
				"\n（好，" + grant + " 她可以写了；记在 " + defaultWriteGrantsPath() + "，重启也算）\n\n",
			);
			continue;
		}
		if (input === "/writes") {
			const writable = writeGuard.storedGrants;
			process.stdout.write(
				writable.length === 0
					? "\n（还没放开任何地方给她写。她问的时候按 a，或者 /write <路径>）\n\n"
					: "\n" +
							writable.map((item) => "· " + item).join("\n") +
							"\n（文件：" +
							defaultWriteGrantsPath() +
							"）\n\n",
			);
			continue;
		}
		if (input.startsWith("/unwrite ")) {
			const target = input
				.slice(9)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (target === "") {
				process.stdout.write("\n用法：/unwrite <文件夹路径>\n\n");
				continue;
			}
			const removed = writeGuard.disallow(target);
			session.setWriteRoots([...writeGuard.grants]);
			session.setShellRoots([...writeGuard.grants]);
			process.stdout.write(
				removed
					? "\n（收回了 " + target + " 的写权限，以后要写得再问你）\n\n"
					: "\n（" + target + " 本来就不在写的名单里）\n\n",
			);
			continue;
		}
		if (input === "/exec") {
			const remembered = shellGuard.remembered;
			process.stdout.write(
				remembered.length === 0
					? "\n（还没记住任何命令。只读的本来就直接跑，其余她问的时候按 a 就记住）\n\n"
					: "\n" +
							remembered.map((item) => "· " + item).join("\n") +
							"\n（文件：" +
							defaultShellAllowPath() +
							"）\n\n",
			);
			continue;
		}
		if (input.startsWith("/unexec ")) {
			const head = input.slice(8).trim().toLowerCase();
			if (head === "") {
				process.stdout.write("\n用法：/unexec <命令头>\n\n");
				continue;
			}
			const removed = shellGuard.forget(head);
			process.stdout.write(
				removed
					? "\n（不再自动放行 " + head + "，下次要跑她会先问你）\n\n"
					: "\n（" + head + " 本来就不在记住的名单里）\n\n",
			);
			continue;
		}
		if (input === "/grants") {
			const open = guard.storedGrants;
			process.stdout.write(
				open.length === 0
					? `\n（还没放开任何文件夹。她问的时候按 a，或者 /allow <路径>）\n\n`
					: `\n${open.map((item) => "· " + item).join("\n")}\n（文件：${defaultGrantsPath()}）\n\n`,
			);
			continue;
		}
		if (input.startsWith("/forget ")) {
			const target = input
				.slice(8)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (target === "") {
				process.stdout.write("\n用法：/forget <文件夹路径>\n\n");
				continue;
			}
			const removed = guard.disallow(target);
			process.stdout.write(
				removed ? `\n（收回了 ${target}，下次要看还得问你）\n\n` : `\n（${target} 本来就不在放行名单里）\n\n`,
			);
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

// 起感知循环与心跳（单发模式也起，但进程跑完就退，等于没起）
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
if (watcher !== null) {
	watcher.start();
	heartbeatTimer = setInterval(() => {
		void heartbeat();
	}, 15_000);
	heartbeatTimer.unref?.();
}

// 带一句话当参数就是单发：node examples/talk.ts "在吗"
const oneShot = args.find((arg) => !arg.startsWith("--"));
if (oneShot === undefined) {
	await repl();
} else {
	await say(oneShot);
}
if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
watcher?.stop();
rl.close();
const summary = await session.endConversation();
if (summary !== null) {
	process.stdout.write(`\n收尾：${summary.tier.tier}，写了 ${summary.memories.length} 条记忆\n`);
	for (const memory of summary.memories) process.stdout.write(`  · [${memory.tier}] ${memory.text}\n`);
}
archive.close();
process.stdout.write("\n走了。\n");
