import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSystemPrompt, describeRelationship } from "../src/persona.ts";
import type { Episode, Persona, PersonaState } from "../src/types.ts";

const persona: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文", "英文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、说话带笑意" },
	traits: ["好奇", "直率", "有点毒舌"],
	values: ["不装", "记得对方说过的话"],
	quirks: ["紧张时会重复对方的词", "喜欢在句尾加一个很短的判断"],
	boundaries: ["不冒充人类打电话", "不在没有同意的情况下录屏"],
};

const state: PersonaState = {
	mood: { label: "playful", valence: 0.6, arousal: 0.5, updatedAt: 1000 },
	energy: 0.72,
	activity: "陪用户打游戏",
	speaking: false,
};

describe("describeRelationship", () => {
	it("clamps invalid closeness", () => {
		assert.equal(describeRelationship(-3).name, "刚认识");
		assert.equal(describeRelationship(3).name, "共同生活");
	});

	it("walks the stages", () => {
		assert.equal(describeRelationship(0.3).name, "熟悉");
		assert.equal(describeRelationship(0.6).name, "朋友");
		assert.equal(describeRelationship(0.95).name, "共同生活");
	});
});

describe("buildSystemPrompt", () => {
	const episode: Episode = {
		id: "e1",
		at: 5000,
		kind: "game",
		summary: "一起打完一局，最后一波她抢了人头",
		tags: ["游戏"],
		importance: 0.6,
	};
	const prompt = buildSystemPrompt({
		persona,
		state,
		relationship: { closeness: 0.55, sharedMoments: 12, lastInteractionAt: 4999 },
		recent: [episode],
		now: 5000,
	});

	it("carries identity, state and relationship", () => {
		assert.match(prompt, /伊里斯/);
		assert.match(prompt, /心情：playful/);
		assert.match(prompt, /关系：朋友/);
		assert.match(prompt, /亲密度 0.55/);
	});

	it("recalls shared moments with a day label", () => {
		assert.match(prompt, /今天｜一起打完一局/);
	});

	it("states boundaries and forbids interviewer mode", () => {
		assert.match(prompt, /不冒充人类打电话/);
		assert.match(prompt, /不要把每句话都变成提问/);
	});

	it("omits the memory section when there is nothing to recall", () => {
		const bare = buildSystemPrompt({
			persona,
			state,
			relationship: { closeness: 0.1, sharedMoments: 0, lastInteractionAt: 0 },
			recent: [],
			now: 5000,
		});
		assert.equal(bare.includes("你们最近一起经历的"), false);
	});
});
