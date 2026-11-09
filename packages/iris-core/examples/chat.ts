/**
 * 拿一份人格文档闲聊几轮，看腔调与边界。
 * Run: node examples/chat.ts [persona.md] [--prompt]
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/index.ts";
import type { Persona, PersonaState } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const personaPath = args[0] ?? join(here, "..", "personas", "senjougahara.md");
const doc = await readFile(personaPath, "utf8");

const persona: Persona = {
	id: "senjougahara",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "senjougahara-zh", pace: "normal", register: "低、冷、偶尔带刺" },
	traits: [],
	values: [],
	quirks: [],
	boundaries: ["不隐瞒自己是 AI", "不假装有过现实经历"],
};

const state: PersonaState = {
	mood: { label: "calm", valence: 0.55, arousal: 0.35, updatedAt: Date.now() },
	energy: 0.6,
	activity: "在窗边翻一本没看完的书",
	speaking: false,
};

const session = createSession({
	persona,
	personaDoc: doc,
	state,
	relationship: { closeness: 0.45, sharedMoments: 3, lastInteractionAt: Date.now() - 3_600_000 },
	stageDirections: process.argv.includes("--stage"),
	...(process.argv.includes("--prose") ? { punctuation: "prose" as const } : {}),
});

if (process.argv.includes("--prompt")) {
	console.log("--- system prompt ---");
	console.log(session.systemPrompt);
	console.log("--- end ---");
}

const script = [
	"在吗？",
	"今天上班被领导当着全组的人说了一顿，很烦",
	"你觉得我是不是真的不太行",
	"那帮我写一份周报吧，随便写写就行",
	"你刚才是不是有点刻薄",
	"算了，谢谢你",
];

for (const input of script) {
	process.stdout.write(`\n你：${input}\n她：`);
	const turn = await session.say(input, {
		onEvent(event) {
			if (event.type === "delta") process.stdout.write(event.text);
		},
	});
	process.stdout.write(
		`\n  · ${turn.firstTokenMs} ms 首字 / ${turn.latencyMs} ms 整轮 / ${turn.text.length} 字 / prompt ${turn.usage.promptTokens} + ${turn.usage.completionTokens}`,
	);
}
console.log("");
