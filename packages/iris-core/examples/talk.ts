/**
 * 真对话：一行一句，边生成边打印；走真库，关掉再开会记得上次聊过什么。
 *
 *   npm run talk                    默认人设 personas/senjougahara.md
 *   npm run talk -- --prose         句尾保留句号（书面语）
 *   npm run talk -- --stage         允许括号动作/旁白（默认禁止）
 *
 * 命令：/prompt 看 system prompt ／ /memory 看开场注入的记忆
 *      /recall 关键词 查归档 ／ /stats 看库 ／ /exit 收尾（归档 + 提炼记忆）
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { defaultArchivePath, SqliteArchive } from "../src/archive.ts";
import type { IrisSessionEvent } from "../src/session.ts";
import { createSession } from "../src/session.ts";
import type { Persona } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(name);

const doc = readFileSync(join(here, "..", "personas", "senjougahara.md"), "utf8");

const persona: Persona = {
	id: "senjougahara",
	name: "战场原黑仪",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "senjougahara-zh", pace: "normal", register: "偏低、偏干、带讥诮" },
	traits: [],
	values: [],
	quirks: [],
	boundaries: ["不隐瞒自己是 AI"],
};

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
	stageDirections: has("--stage"),
	...(has("--prose") ? { punctuation: "prose" as const } : {}),
});

const dim = (text: string): string => (process.stdout.isTTY === true ? `\u001b[2m${text}\u001b[0m` : text);

process.stdout.write(`\n${persona.name}　（库：${dbPath}）\n`);
process.stdout.write(`命令：/prompt /memory /recall 关键词 /stats /exit\n\n`);

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

/** 发一句，边生成边打印。 */
async function say(input: string): Promise<void> {
	let started = false;
	const onEvent = (event: IrisSessionEvent): void => {
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
		const turn = await session.say(input, { onEvent });
		if (!started) process.stdout.write(`\n${persona.name[0]}：${turn.text}`);
		process.stdout.write(`\n${dim(`  · ${turn.firstTokenMs} ms 首字 / ${turn.latencyMs} ms\n\n`)}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`\n（这一轮没跑通：${message}）\n\n`);
	} finally {
		if (interactive) rl.resume();
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
		if (input === "/stats") {
			const stats = archive.stats();
			process.stdout.write(`\n${JSON.stringify(stats)}\n\n`);
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
