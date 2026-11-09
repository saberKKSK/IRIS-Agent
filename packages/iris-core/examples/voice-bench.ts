/**
 * 人类习惯基准：跑一组真实口吻的输入，量回复的形状，和贴吧真人语料对比。
 * Run: node examples/voice-bench.ts [tag]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/index.ts";
import type { Persona, PersonaState } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2] ?? "run";
const doc = readFileSync(join(here, "..", "personas", "senjougahara.md"), "utf8");

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

const AI_WORDS = [
	"首先",
	"其次",
	"综上",
	"总之",
	"换句话说",
	"值得一提的是",
	"需要注意的是",
	"这意味着",
	"本质上",
	"不得不说",
	"总结一下",
	"总的来说",
	"从某种角度",
	"值得注意的是",
];

export type ReplyShape = {
	chars: number;
	sentences: number;
	avgSentence: number;
	questionEnd: boolean;
	questions: number;
	aiWords: string[];
	dash: boolean;
	colon: boolean;
	tripleDun: boolean;
	listLines: number;
	firstPersonOpener: boolean;
};

export function shape(reply: string): ReplyShape {
	const text = reply.trim();
	const sentences = text
		.split(/[。！？!?…]+/u)
		.map((s) => s.trim())
		.filter(Boolean);
	const chars = [...text.replace(/\s/g, "")].length;
	return {
		chars,
		sentences: sentences.length,
		avgSentence: sentences.length ? Math.round(chars / sentences.length) : chars,
		questionEnd: /[？?]\s*$/u.test(text),
		questions: (text.match(/[？?]/gu) ?? []).length,
		aiWords: AI_WORDS.filter((w) => text.includes(w)),
		dash: text.includes("——"),
		colon: /[：:]/u.test(text),
		tripleDun: (text.match(/、/gu) ?? []).length >= 2,
		listLines: text.split(/\n/u).filter((l) => /^\s*(?:[-*·•]|\d+[.、])/u.test(l)).length,
		firstPersonOpener: /^[我我]/u.test(text),
	};
}

const INPUTS = [
	"在吗",
	"今天上班被领导当着全组的人说了一顿，很烦",
	"你说我是不是真的不太行",
	"帮我写份周报呗，随便写写",
	"你刚才是不是有点刻薄",
	"我朋友说我最近变沉默了",
	"哈哈哈哈哈这个视频好好笑",
	"你会不会有一天不记得我",
	"推荐个周末能去的地方",
	"我今天加完班走回家，路上没什么人",
	"你老是这样",
	"算了，睡了",
	"你这嘴怎么这么欠，说句话都要刺人一下，谁受得了你",
];

const session = createSession({
	persona,
	personaDoc: doc,
	state,
	relationship: { closeness: 0.45, sharedMoments: 3, lastInteractionAt: Date.now() - 3_600_000 },
});

const rows: { input: string; reply: string; shape: ReplyShape; ms: number }[] = [];
for (const input of INPUTS) {
	const turn = await session.say(input);
	rows.push({ input, reply: turn.text, shape: shape(turn.text), ms: turn.latencyMs });
	process.stdout.write("·");
}
process.stdout.write("\n\n");
for (const row of rows) {
	console.log("你：" + row.input);
	console.log("她：" + row.reply + "   [" + row.shape.chars + "字/" + row.shape.sentences + "句]");
}

const chars = rows.map((r) => r.shape.chars).sort((a, b) => a - b);
const median = chars[Math.floor(chars.length / 2)];
const pct = (n: number) => Math.round((n / rows.length) * 1000) / 10;
const total = chars.reduce((a, b) => a + b, 0);
const aiHits = rows.reduce((a, r) => a + r.shape.aiWords.length, 0);

const summary = {
	tag,
	n: rows.length,
	medianChars: median,
	meanChars: Math.round(total / rows.length),
	pctLe20: pct(rows.filter((r) => r.shape.chars <= 20).length),
	pctEndQuestion: pct(rows.filter((r) => r.shape.questionEnd).length),
	pctMultiSentence: pct(rows.filter((r) => r.shape.sentences >= 3).length),
	aiWordsPer100: Math.round((aiHits / total) * 100 * 100) / 100,
	pctDash: pct(rows.filter((r) => r.shape.dash).length),
	pctColon: pct(rows.filter((r) => r.shape.colon).length),
	pctTripleDun: pct(rows.filter((r) => r.shape.tripleDun).length),
	msMedian: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
};
console.log("\n" + JSON.stringify(summary, null, 1));

const dir = join(here, "..", ".artifacts");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "voice-" + tag + ".json"), JSON.stringify({ summary, rows }, null, 1));
