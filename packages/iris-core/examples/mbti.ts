/**
 * 让她做一遍 OEJTS 1.2（32 题，1–5 分）。
 *
 * 为什么换这份：之前那份是国内的 MBTI 精简版（同浙就业指导中心，转载在搜狐），四个维度全 100%，
 * 区分度太低。OEJTS 是国外的公开量表，题目、计分规则、中文译文都公开，且是 1–5 分量表，
 * 不会只剩「非此即彼」。题面来源与授权见 ./oejts.ts 的文件头。
 *
 *   node examples/mbti.ts
 *   node examples/mbti.ts --quiet      只打结果
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/session.ts";
import type { Persona } from "../src/types.ts";
import { OEJTS_ITEMS, OEJTS_TOTAL, scoreOejts, temperamentOf } from "./oejts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const quiet = process.argv.includes("--quiet");
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

const session = createSession({
	persona,
	personaDoc: doc,
	relationship: { closeness: 0.45, sharedMoments: 0, lastInteractionAt: Date.now() },
});

const answers: Record<number, number> = {};
const reasons: { item: number; value: number; reason: string }[] = [];

function parseValue(text: string): { value: number | null; reason: string } {
	const match = text.match(/[1-5]/);
	if (match === null || match.index === undefined) return { value: null, reason: text.trim() };
	const value = Number(match[0]);
	const rest = text
		.slice(match.index + 1)
		.replace(/^[\s:：，,。.、\-—分]+/u, "")
		.trim();
	return { value, reason: rest };
}

let index = 0;
for (const item of OEJTS_ITEMS) {
	index += 1;
	const ask = [
		`这是一份性格测试，一共 ${OEJTS_TOTAL} 题，这是第 ${index} 题。按你自己的判断打一个分。`,
		`题目：${item.title}`,
		`1 = 完全像「${item.left}」`,
		`2 = 偏「${item.left}」`,
		`3 = 两边都像，或者都不像`,
		`4 = 偏「${item.right}」`,
		`5 = 完全像「${item.right}」`,
		"只回一个 1 到 5 的数字，再跟一句不超过二十个字的理由。",
	].join("\n");

	const turn = await session.say(ask);
	const { value, reason } = parseValue(turn.text);
	const resolved = value ?? 3;
	answers[item.id] = resolved;
	reasons.push({ item: index, value: resolved, reason });

	if (!quiet) {
		const label = resolved <= 2 ? item.left : resolved === 3 ? "中性" : item.right;
		process.stdout.write(`${String(index).padStart(2, " ")}. ${item.title} → ${resolved}（${label}）`);
		if (reason !== "") process.stdout.write(`　「${reason}」`);
		process.stdout.write("\n");
	}
}

const result = scoreOejts(answers);

process.stdout.write("\n=== 结果 ===\n");
for (const pole of result.poles) {
	process.stdout.write(
		`${pole.dimension}  ${result.scores[pole.dimension]}/40  →  ${pole.pole} ${pole.percent}%（另一极 ${100 - pole.percent}%）\n`,
	);
}

process.stdout.write(`\n${result.type}　${temperamentOf(result.type)}\n`);

const neutral = Object.values(answers).filter((v) => v === 3).length;
const strong = Object.values(answers).filter((v) => v === 1 || v === 5).length;
process.stdout.write(`${OEJTS_TOTAL} 题：强烈倾向 ${strong} 题、中性 ${neutral} 题\n`);
