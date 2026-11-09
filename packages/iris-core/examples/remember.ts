/**
 * 跨进程的记性：同一个库文件，关掉再打开还记得。
 *
 * 用法：
 *   node examples/remember.ts "记住这个：我对花生过敏"   # 说一句并落库
 *   node examples/remember.ts --probe                  # 只看重启后的 prompt 里还记得什么（不联网）
 *   node examples/remember.ts --self mbti "我做过…得出…"  # 往她自己的账上记一条（只由人写）
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
const args = process.argv.slice(2);
const probe = args.includes("--probe");

console.log("库文件  " + path);

// --self <key> <value>：只由人写，记的是她自己的账
const selfIndex = args.indexOf("--self");
if (selfIndex >= 0) {
	const key = args[selfIndex + 1] ?? "";
	const value = args
		.slice(selfIndex + 2)
		.join(" ")
		.trim();
	if (key.length === 0 || value.length === 0) {
		console.log("用法：--self <key> <value>");
		archive.close();
		process.exit(1);
	}
	const fact = archive.rememberSelf(key, value);
	console.log("自我事实  " + fact.key);
	console.log(fact.value);
	archive.close();
	process.exit(0);
}

const text = args
	.filter((arg) => !arg.startsWith("--"))
	.join(" ")
	.trim();

/** 把 prompt 里某一节整段捞出来（不联网）。 */
function section(prompt: string, marker: string): string {
	const index = prompt.indexOf(marker);
	if (index < 0) return "";
	return (prompt.slice(index + marker.length).split("## ")[0] ?? "").trim();
}

if (probe || text.length === 0) {
	const prompt = session.systemPrompt;
	const self = section(prompt, "## 关于你自己").split("别人转述")[0]?.trim() ?? "";
	const memory = section(prompt, "## 你记得的事");
	console.log("她自己的账：");
	console.log(self.length === 0 ? "（空）" : self);
	console.log("\n重启后的记忆：");
	console.log(memory.length === 0 ? "（空）" : memory);
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
