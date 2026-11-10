import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ExpressionStream, expressionId, IRIS_EXPRESSIONS, splitExpression } from "../src/expression.ts";

describe("词表：她在正文里写的那几个字", () => {
	test("认识的给 id，不认识的给 null", () => {
		assert.equal(expressionId("脸红"), "blush");
		assert.equal(expressionId(" 得意 "), "smug_eyes");
		assert.equal(expressionId("div"), null);
	});

	test("八张脸一个不多一个不少，id 互不重复", () => {
		assert.equal(IRIS_EXPRESSIONS.length, 8);
		assert.equal(new Set(IRIS_EXPRESSIONS.map((item) => item.id)).size, 8);
	});
});

describe("整段文本：标记摘掉，脸留下来", () => {
	test("写在最前面", () => {
		assert.deepEqual(splitExpression("<脸红>你还知道回来"), { text: "你还知道回来", expression: "blush" });
	});

	test("夹在句子中间也摘掉", () => {
		assert.deepEqual(splitExpression("真是<冷汗>服了你了"), { text: "真是服了你了", expression: "cold_sweat" });
	});

	test("不认识的标签原样留着（她写 <div> 也照原样）", () => {
		assert.deepEqual(splitExpression("<div>你好"), { text: "<div>你好", expression: null });
	});

	test("两张脸取最后一张", () => {
		assert.deepEqual(splitExpression("<黑脸><眼泪>算了"), { text: "算了", expression: "tears" });
	});

	test("数学里的小于号不会被吃掉", () => {
		const result = splitExpression("3 < 5 是对的");
		assert.equal(result.text, "3 < 5 是对的");
		assert.equal(result.expression, null);
	});
});

describe("流式：增量把标记劈成两半也认得出来", () => {
	test("先来 <脸，再来 红>，字幕里不留标记", () => {
		const stream = new ExpressionStream();
		assert.equal(stream.push("<脸"), "");
		assert.equal(stream.expression, null);
		assert.equal(stream.push("红>你走开"), "你走开");
		assert.equal(stream.expression, "blush");
	});

	test("压住的尾巴在 flush 时原样出来", () => {
		const stream = new ExpressionStream();
		assert.equal(stream.push("a < b"), "a ");
		assert.equal(stream.flush(), "< b");
	});

	test("一直没等到 > 的长串按正文吐", () => {
		const stream = new ExpressionStream();
		const out = stream.push("<这是一个很长很长的不是标记的东西");
		assert.equal(out, "<这是一个很长很长的不是标记的东西");
	});

	test("正文分片拼接后一字不差", () => {
		const stream = new ExpressionStream();
		const text = stream.push("你") + stream.push("说") + stream.push("呢") + stream.flush();
		assert.equal(text, "你说呢");
	});
});
