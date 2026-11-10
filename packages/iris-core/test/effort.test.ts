import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	chooseEffort,
	classifyEffort,
	type EffortClassifier,
	type EffortEnvelope,
	parseEffortReply,
	rankOf,
	ruleEffort,
} from "../src/effort.ts";

describe("规则版：这一条该不该多想", () => {
	test("「继续」继承上一轮的档，不会当成打招呼", () => {
		const ruled = ruleEffort("继续", { previousEffort: "low", unfinished: true });
		assert.equal(ruled?.effort, "low");
		assert.equal(ruled?.relation, "continues");
		assert.equal(ruled?.reason, "接着说没干完的活");
	});

	test("「继续」但上一轮本来是 none，就还是 none", () => {
		const ruled = ruleEffort("嗯，继续", { previousEffort: "none" });
		assert.equal(ruled?.effort, "none");
	});

	test("要核对、要讲道理的话升到 low", () => {
		for (const text of [
			"他说我 MBTI 是 62 到 78，跟我自己记的 72 到 78 对不对得上",
			"你凭什么这么说",
			"这两种说法哪个更站得住",
		]) {
			assert.equal(ruleEffort(text)?.effort, "low", text);
		}
	});

	test("一次贴进来一大段材料也升档", () => {
		const text = "他说的话是这样：" + "这件事我早就想过了，一直没找到合适的时机跟你讲。".repeat(8);
		assert.equal(ruleEffort(text)?.effort, "low");
	});

	test("招呼和应答留在 none", () => {
		for (const text of ["在吗", "谢谢", "哈哈", "嗯嗯"]) {
			assert.equal(ruleEffort(text)?.effort, "none", text);
		}
		assert.equal(ruleEffort("今天下班有点累")?.effort, "none");
		assert.equal(ruleEffort("这件衣服好看吗")?.effort, "none");
	});

	test("普通闲聊拿不准：返回 null，交给调用方", () => {
		assert.equal(ruleEffort("今天下午去了海边，风很大，后来吃了点东西就回来了"), null);
		assert.equal(ruleEffort("   "), null);
	});
});

describe("parseEffortReply：模型回话读成判断", () => {
	test("干净的 JSON", () => {
		const got = parseEffortReply('{"effort":"low","relation":"continues","confidence":0.82}');
		assert.deepEqual(got, { effort: "low", relation: "continues", confidence: 0.82 });
	});

	test("包在代码围栏里、前面还写了一句废话", () => {
		const got = parseEffortReply(
			'好的，这是判断：\n\u0060\u0060\u0060json\n{"effort":"none","relation":"new","confidence":1}\n\u0060\u0060\u0060',
		);
		assert.equal(got?.effort, "none");
		assert.equal(got?.confidence, 1);
	});

	test("读不出来就当没答，不猜", () => {
		assert.equal(parseEffortReply("我觉得可以稍微想一下"), null);
		assert.equal(parseEffortReply('{"effort":"很高"}'), null);
		assert.equal(parseEffortReply("{坏的 json"), null);
	});
});

const say =
	(effort: "none" | "low" | "high", relation: "continues" | "new", confidence: number): EffortClassifier =>
	async () => ({ effort, relation, confidence });

describe("chooseEffort：一条硬规则 + 低置信向上取", () => {
	test("规则能判就不去问模型", async () => {
		let asked = 0;
		const classifier: EffortClassifier = async () => {
			asked += 1;
			return { effort: "high", relation: "new", confidence: 1 };
		};
		const judged = await chooseEffort("在吗", {}, { classifier, allowClassifier: true });
		assert.equal(judged.effort, "none");
		assert.equal(judged.source, "rule");
		assert.equal(asked, 0);
	});

	test("规则拿不准、关着模型：保持默认档", async () => {
		const judged = await chooseEffort("今天下午去了海边，风很大，后来吃了点东西就回来了");
		assert.equal(judged.effort, "none");
		assert.equal(judged.source, "fallback");
		assert.equal(judged.reason, "没意见，保持原档");
	});

	test("拿不准时问模型，用它的判断", async () => {
		let asked = 0;
		const classifier: EffortClassifier = async (text, envelope) => {
			asked += 1;
			assert.equal(envelope.previousEffort, "none");
			assert.match(text, /海边/);
			return { effort: "low", relation: "new", confidence: 0.9 };
		};
		const judged = await chooseEffort(
			"今天下午去了海边，风很大，后来吃了点东西就回来了",
			{ previousEffort: "none" },
			{ classifier, allowClassifier: true },
		);
		assert.equal(asked, 1);
		assert.equal(judged.effort, "low");
		assert.equal(judged.source, "classifier");
	});

	test("置信度低：在两档里取更强的那个", async () => {
		const judged = await chooseEffort(
			"今天下午去了海边，风很大，后来吃了点东西就回来了",
			{ previousEffort: "low" },
			{ classifier: say("none", "new", 0.35), allowClassifier: true },
		);
		assert.equal(judged.effort, "low");
		assert.match(judged.reason, /往上取一档/);
	});

	test("硬规则：接着说没干完的活，不降档", async () => {
		const judged = await chooseEffort(
			"今天下午去了海边，风很大，后来吃了点东西就回来了",
			{ previousEffort: "high", unfinished: true },
			{ classifier: say("none", "continues", 0.95), allowClassifier: true },
		);
		assert.equal(judged.effort, "high");
		assert.match(judged.reason, /不降档/);
	});

	test("活干完了就不锚定：说降就降", async () => {
		const judged = await chooseEffort(
			"今天下午去了海边，风很大，后来吃了点东西就回来了",
			{ previousEffort: "high", unfinished: false },
			{ classifier: say("none", "continues", 0.95), allowClassifier: true },
		);
		assert.equal(judged.effort, "none");
	});

	test("模型超时 / 抛错 / 乱答：静默回落到默认档", async () => {
		const envelope: EffortEnvelope = { previousEffort: "none" };
		const slow: EffortClassifier = () => new Promise((resolve) => setTimeout(() => resolve(null), 500));
		const timedOut = await chooseEffort("今天下午去了海边，风很大，后来吃了点东西就回来了", envelope, {
			classifier: slow,
			allowClassifier: true,
			classifierTimeoutMs: 20,
		});
		assert.equal(timedOut.source, "fallback");
		assert.equal(timedOut.effort, "none");

		const thrown: EffortClassifier = async () => {
			throw new Error("network down");
		};
		const failed = await chooseEffort("今天下午去了海边，风很大，后来吃了点东西就回来了", envelope, {
			classifier: thrown,
			allowClassifier: true,
		});
		assert.equal(failed.source, "fallback");
	});

	test("档位有大小：high 比 low 强，low 比 none 强", () => {
		assert.ok(rankOf("high") > rankOf("low"));
		assert.ok(rankOf("low") > rankOf("none"));
	});
});

describe("classifyEffort：请求形状", () => {
	test("超时后 classifyEffort 自己会抛，由 chooseEffort 兜住", async () => {
		const classifier = classifyEffort({ timeoutMs: 1 });
		await assert.rejects(classifier("随便说点什么吧", {}));
	});
});
