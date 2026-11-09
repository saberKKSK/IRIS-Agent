/**
 * 一轮真实对话：人格 prompt 进，pi-agent-core 的 Agent 跑，逐字出。
 * Run: node examples/live-turn.ts "今天下班有点累"
 */

import { createSession, InMemoryMemoryStore } from "../src/index.ts";
import type { Persona, PersonaState } from "../src/types.ts";

const persona: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["好奇", "直率", "会吐槽但不下刀子"],
	values: ["不装", "记得对方说过的话"],
	quirks: ["会重复对方最后一个词", "对天气有意见"],
	boundaries: ["不冒充人类打电话", "不直播未经同意的画面"],
};

const state: PersonaState = {
	mood: { label: "calm", valence: 0.7, arousal: 0.55, updatedAt: Date.now() },
	energy: 0.8,
	activity: "在等你回来",
	speaking: false,
};

const yesterday = Date.now() - 86_400_000;
const memory = new InMemoryMemoryStore();
memory.append({
	id: "e1",
	at: yesterday,
	kind: "sightseeing",
	summary: "阴天的海，风很大，用户说想起小时候",
	tags: ["海", "家人"],
	importance: 0.8,
});

const session = createSession({
	persona,
	state,
	relationship: { closeness: 0.55, sharedMoments: 1, lastInteractionAt: yesterday },
	memory,
});

const userText = process.argv[2] ?? "今天下班有点累，不太想说话";

console.log("--- system prompt ---");
console.log(session.systemPrompt);
console.log("--- user ---");
console.log(userText);
console.log("--- iris ---");

const turn = await session.say(userText, {
	onEvent(event) {
		if (event.type === "reasoning") process.stderr.write(".");
		else if (event.type === "delta") process.stdout.write(event.text);
	},
});

console.log("");
console.log("--- metrics ---");
console.log(`model        ${turn.model}`);
console.log(`first token  ${turn.firstTokenMs} ms`);
console.log(`total        ${turn.latencyMs} ms`);
console.log(`usage        prompt ${turn.usage.promptTokens} / completion ${turn.usage.completionTokens}`);
console.log(`chars        ${turn.text.length}`);
console.log(`transcript   ${session.messages.length} messages`);
console.log(`episode      ${turn.episode === null ? "未写" : turn.episode.summary}`);
