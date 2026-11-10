/**
 * 输入队列（ADR-0033）：两处同时等输入时谁都别被顶掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LineQueue } from "../src/lines.ts";

test("先来的先拿：存着的行按顺序发", async () => {
	const queue = new LineQueue();
	queue.push("一");
	queue.push("二");
	assert.equal(queue.buffered, 2);
	assert.equal(await queue.next(), "一");
	assert.equal(await queue.next(), "二");
});

test("等的时候来行会立刻醒", async () => {
	const queue = new LineQueue();
	const waiting = queue.next();
	queue.push("来了");
	assert.equal(await waiting, "来了");
});

test("两处同时等：一个都不能少（当年就是这么挂死的）", async () => {
	const queue = new LineQueue();
	const first = queue.next();
	const second = queue.next();
	queue.push("给第一个");
	queue.push("给第二个");
	assert.equal(await first, "给第一个");
	assert.equal(await second, "给第二个");
	assert.equal(queue.buffered, 0);
});

test("关掉输入：还在等的人拿到 null，缓冲里的行照样发完", async () => {
	const queue = new LineQueue();
	const waiting = queue.next();
	queue.push("尾巴");
	queue.close();
	assert.equal(await waiting, "尾巴");
	assert.equal(await queue.next(), null);
	assert.equal(queue.closed, true);
});
