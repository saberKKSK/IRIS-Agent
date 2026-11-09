/**
 * 跨进程的记性：同一个库文件，关掉再打开还记得。
 *
 * 用法：
 *   node examples/remember.ts "记住这个：我对花生过敏"   # 说一句并落库
 *   node examples/remember.ts --probe                  # 只看重启后的 prompt 里还记得什么（不联网）
 *
 * 库默认在 ~/.iris/iris.db（可用 IRIS_ARCHIVE 指到别处）。
 */

import { createSession, defaultArchivePath, SqliteArchive } from "../src/index.ts";
import type { Persona } from "../src/types.ts";

const persona: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["好奇", "直率"],
	values: ["不装", "记得对方说过的话"],
	quirks: ["会重复对方最后一个词"],
	boundaries: ["不冒充人类打电话"],
};

const path = defaultArchivePath();
const archive = new SqliteArchive({ path });
const session = createSession({ persona, archive });
const probe = process.argv.includes("--probe");
const text = process.argv
	.slice(2)
	.filter((arg) => !arg.startsWith("--"))
	.join(" ")
	.trim();

console.log("库文件  " + path);

if (probe || text.length === 0) {
	const prompt = session.systemPrompt;
	const marker = "## 你记得的事";
	const index = prompt.indexOf(marker);
	if (index < 0) {
		console.log("重启后的记忆：（空）");
	} else {
		const body = prompt.slice(index + marker.length).split("## ")[0] ?? "";
		console.log("重启后的记忆：");
		console.log(body.trim());
	}
	archive.close();
	process.exit(0);
}

console.log("--- user ---");
console.log(text);
console.log("--- iris ---");

const turn = await session.say(text, {
	onEvent(event) {
		if (event.type === "delta") process.stdout.write(event.text);
	},
});
console.log("");
console.log(`first token  ${turn.firstTokenMs} ms`);
console.log(`total        ${turn.latencyMs} ms`);

const finished = await session.endConversation();
if (finished !== null) {
	console.log(`分档        ${finished.tier.tier}（${finished.tier.reason}）`);
	for (const memory of finished.memories) console.log(`记忆        [${memory.status}] ${memory.text}`);
}
archive.close();
