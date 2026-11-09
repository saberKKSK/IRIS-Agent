import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RawTurn, SqliteArchive } from "../src/archive.ts";
import { llmClassifier, llmDistiller, llmMemory, parseDrafts, parseTier } from "../src/distill.ts";

const START = 1_760_000_000_000;

function chat(...texts: string[]): RawTurn[] {
	return texts.map((text, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: text,
		at: START + index * 1000,
	}));
}

describe("分档解析", () => {
	it("剥掉代码块围栏，认 tier 白名单", () => {
		const decided = parseTier(
			'\u0060\u0060\u0060json\n{"tier":"critical","reason":"用户要求记住"}\n\u0060\u0060\u0060',
		);
		assert.equal(decided?.tier, "critical");
		assert.equal(decided?.reason, "用户要求记住");
		assert.equal(decided?.source, "model");
	});

	it("白名单外的档位、坏 JSON 都返回 undefined", () => {
		assert.equal(parseTier('{"tier":"important"}'), undefined);
		assert.equal(parseTier("我觉得挺重要的"), undefined);
		assert.equal(parseTier(""), undefined);
	});
});

describe("提炼解析", () => {
	it("quote 不在原文里就丢掉，text 截断", () => {
		const source = "用户：我对花生过敏 伊里斯：记住了";
		const drafts = parseDrafts(
			JSON.stringify({
				memories: [
					{ text: "对花生过敏", quote: "我对花生过敏", importance: 0.9, tags: ["过敏"] },
					{ text: "养了一只猫", quote: "我养了一只猫" },
				],
			}),
			source,
		);
		assert.equal(drafts.length, 2);
		assert.equal(drafts[0]?.quote, "我对花生过敏");
		assert.equal(drafts[1]?.quote, undefined, "原文里没有的 quote 不能留");
	});

	it("最多 5 条、tags 最多 4 个、importance 夹在 0–1", () => {
		const many = Array.from({ length: 9 }, (_, index) => ({
			text: `事实 ${index}`,
			importance: index === 0 ? 3 : -2,
			tags: ["a", "b", "c", "d", "e"],
		}));
		const drafts = parseDrafts(JSON.stringify({ memories: many }), "");
		assert.equal(drafts.length, 5);
		assert.equal(drafts[0]?.importance, 1);
		assert.equal(drafts[1]?.importance, 0);
		assert.equal(drafts[0]?.tags?.length, 4);
	});

	it("空数组、坏 JSON 都是空结果", () => {
		assert.deepEqual(parseDrafts('{"memories":[]}', ""), []);
		assert.deepEqual(parseDrafts("随便说说", ""), []);
	});
});

describe("模型分档器与提炼器", () => {
	it("分类器把对话喂给模型，产出 model 档", async () => {
		let seen = "";
		const classifier = llmClassifier({
			complete: async (prompt) => {
				seen = prompt;
				return '{"tier":"medium","reason":"约定"}';
			},
		});
		const decided = await classifier({ turns: chat("周末一起去看海吧", "好呀"), text: "周末一起去看海吧 好呀" });
		assert.equal(decided?.tier, "medium");
		assert.ok(seen.includes("周末一起去看海吧"), "prompt 里必须带上对话原文");
	});

	it("分类器失败返回 undefined，交给规则兜底", async () => {
		const errors: unknown[] = [];
		const classifier = llmClassifier({
			complete: async () => {
				throw new Error("gateway down");
			},
			onError: (error) => errors.push(error),
		});
		assert.equal(await classifier({ turns: chat("在吗", "在"), text: "在吗 在" }), undefined);
		assert.equal(errors.length, 1);
	});

	it("提炼器失败或空结果都返回 undefined", async () => {
		const failing = llmDistiller({
			complete: async () => {
				throw new Error("timeout");
			},
		});
		assert.equal(await failing({ turns: chat("累", "那就歇着"), tier: "ordinary" }), undefined);

		const empty = llmDistiller({ complete: async () => '{"memories":[]}' });
		assert.equal(await empty({ turns: chat("嗯", "嗯"), tier: "ordinary" }), undefined);
	});
});

describe("接进归档：记忆从流水句变成短事实", () => {
	it("LLM 版写进库的是短事实，不是整段对话", async () => {
		const archive = new SqliteArchive({
			path: ":memory:",
			now: () => START,
			...llmMemory({
				complete: async (_prompt, call) =>
					call.system.includes("分档")
						? '{"tier":"critical","reason":"用户明确要求记住"}'
						: '{"memories":[{"text":"对花生过敏","quote":"我对花生过敏","importance":0.9,"tags":["过敏"]}]}',
			}),
		});
		const { tier, memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("记住这个：我对花生过敏", "花生过敏，记住了。"),
		});
		assert.equal(tier.tier, "critical");
		assert.equal(tier.source, "model");
		assert.equal(memories.length, 1);
		assert.equal(memories[0]?.text, "对花生过敏");
		assert.equal(memories[0]?.quote, "我对花生过敏");
		assert.equal(memories[0]?.status, "locked");
	});

	it("模型挂了也照样入库：回落规则档 + 兜底摘要", async () => {
		const archive = new SqliteArchive({
			path: ":memory:",
			now: () => START,
			...llmMemory({
				complete: async () => {
					throw new Error("gateway down");
				},
			}),
		});
		const { tier, memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("今天风挺大", "是啊，别开窗"),
		});
		assert.equal(tier.source, "rule");
		assert.equal(tier.tier, "ordinary");
		assert.equal(memories.length, 1);
		assert.ok(memories[0]?.text.includes("今天风挺大"), "兜底摘要应当包含对话内容");
	});
});
