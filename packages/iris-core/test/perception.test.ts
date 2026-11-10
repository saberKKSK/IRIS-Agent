/**
 * 感知层测试（ADR-0037）：变化检测、什么时候才叫视觉模型、注进去的那一行长什么样。
 * 不碰真屏幕：fit / capture / describe 全是假货。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agoText, CHANGE_THRESHOLD, FIT_HEIGHT, FIT_WIDTH, frameDiff, ScreenWatcher } from "../src/perception.ts";
import type { CapturedFrame } from "../src/screen.ts";
import type { VisionNote } from "../src/vision.ts";

function shot(): CapturedFrame {
	return { path: "C:/tmp/iris-screen/frame.jpg", bytes: 29_000, width: 512, height: 320, ms: 240 };
}

function note(text: string): VisionNote {
	return { text, model: "fake-vision", latencyMs: 8_700, bytes: 29_000, promptTokens: 248, completionTokens: 12 };
}

/** 一整张缩略图都是同一个灰度值。 */
function flat(value: number): Buffer {
	return Buffer.alloc(FIT_WIDTH * FIT_HEIGHT, value);
}

describe("感知层：屏幕变化（ADR-0037）", () => {
	it("同一张图差 0，差一格灰度就是 1，尺寸不对当全变", () => {
		assert.equal(frameDiff(flat(10), flat(10)), 0);
		assert.equal(frameDiff(flat(10), flat(11)), 1);
		assert.equal(frameDiff(flat(10), Buffer.alloc(4, 10)), 255);
	});

	it("多久之前看的，说成人话", () => {
		assert.equal(agoText(1_000, 40_000), "刚刚");
		assert.equal(agoText(0, 120_000), "2 分钟前");
		assert.equal(agoText(0, 7_200_000), "2 小时前");
	});

	it("画面没变就不叫视觉模型；变了才重新描述", async () => {
		let value = 10;
		let looks = 0;
		const watcher = new ScreenWatcher({
			fit: async () => flat(value),
			capture: async () => shot(),
			describe: async () => {
				looks += 1;
				return note("第一次看到的东西");
			},
			now: () => 1_000,
		});
		await watcher.poll();
		assert.equal(looks, 1, "第一次一定要看一眼");
		assert.equal(watcher.latest?.note, "第一次看到的东西");
		await watcher.poll();
		assert.equal(looks, 1, "一模一样就不该再花 9 秒");
		value = 10 + CHANGE_THRESHOLD + 1;
		await watcher.poll();
		assert.equal(looks, 2, "画面变了要重新看");
		assert.equal(watcher.stats.ticks, 3);
		assert.equal(watcher.stats.looks, 2);
	});

	it("画面一直没变，也要隔一阵重新描述：记忆不能一直停在半小时前", async () => {
		let at = 0;
		let looks = 0;
		const watcher = new ScreenWatcher({
			fit: async () => flat(10),
			capture: async () => shot(),
			describe: async () => {
				looks += 1;
				return note("还是在那一页");
			},
			refreshMs: 60_000,
			now: () => at,
		});
		await watcher.poll();
		at = 30_000;
		await watcher.poll();
		assert.equal(looks, 1, "半分钟还不到刷新时间");
		at = 61_000;
		await watcher.poll();
		assert.equal(looks, 2, "过了刷新时间就该再看一次");
	});

	it("注进去的那一行带上「多久之前看的」，太旧要标出来可能已经变了", async () => {
		let at = 100_000;
		const watcher = new ScreenWatcher({
			fit: async () => flat(10),
			capture: async () => shot(),
			describe: async () => note("一个编辑器，开着 markdown"),
			staleMs: 60_000,
			refreshMs: 10_000_000,
			now: () => at,
		});
		assert.equal(watcher.noteFor(), null, "还没看过就没有东西可注");
		await watcher.poll();
		const fresh = watcher.noteFor();
		assert.match(fresh ?? "", /他屏幕上是：一个编辑器/u);
		assert.match(fresh ?? "", /刚刚/u);
		assert.equal(watcher.changedSince(0), true);
		at = 200_000;
		assert.match(watcher.noteFor() ?? "", /可能已经变了/u);
		assert.equal(watcher.changedSince(150_000), false);
	});

	it("抓不到屏幕 / 模型不回：不抛，也不把上一眼的内容覆盖掉", async () => {
		let fail = false;
		const watcher = new ScreenWatcher({
			fit: async () => {
				if (fail) throw new Error("gdigrab 没了");
				return flat(10);
			},
			capture: async () => shot(),
			describe: async () => note("桌面上有一个窗口"),
			now: () => 1_000,
		});
		await watcher.poll();
		assert.equal(watcher.latest?.note, "桌面上有一个窗口");
		fail = true;
		await watcher.poll();
		assert.equal(watcher.latest?.note, "桌面上有一个窗口", "抓坏了不该把旧描述清掉");
	});

	it("描述是空的就当没看见（模型偶尔只回一句空话）", async () => {
		const watcher = new ScreenWatcher({
			fit: async () => flat(10),
			capture: async () => shot(),
			describe: async () => note("   "),
			now: () => 1_000,
		});
		await watcher.poll();
		assert.equal(watcher.latest, null);
		assert.equal(watcher.stats.looks, 0);
	});
});
