import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AttentionScheduler, laneFor } from "../src/attention.ts";
import type { PerceptionEvent } from "../src/types.ts";

const speech: PerceptionEvent = { kind: "user.speech", at: 1, text: "在吗", confidence: 0.9, partial: false };
const look: PerceptionEvent = { kind: "user.look", at: 2, subject: "海", summary: "阴天的海面", frameRef: "f1" };
const tick: PerceptionEvent = { kind: "clock.tick", at: 3, localHour: 15, localMinute: 0 };

describe("laneFor", () => {
	it("routes live conversation to realtime", () => {
		assert.equal(laneFor(speech), "realtime");
		assert.equal(laneFor({ kind: "device.presence", at: 0, device: "android", online: true }), "realtime");
	});

	it("routes frame understanding and game state to async", () => {
		assert.equal(laneFor(look), "async");
		assert.equal(
			laneFor({ kind: "game.state", at: 0, game: "x", phase: "mid", objective: "win", health: 4 }),
			"async",
		);
	});

	it("routes clocks and idleness to background", () => {
		assert.equal(laneFor(tick), "background");
		assert.equal(laneFor({ kind: "user.idle", at: 0, idleMinutes: 20 }), "background");
	});
});

describe("AttentionScheduler", () => {
	it("serves realtime before async", () => {
		const scheduler = new AttentionScheduler({ backgroundIdleMs: 1000 });
		scheduler.enqueue(look);
		scheduler.enqueue(speech);
		assert.equal(scheduler.take(10)?.kind, "user.speech");
		assert.equal(scheduler.take(11)?.kind, "user.look");
	});

	it("holds background until the foreground is quiet", () => {
		const scheduler = new AttentionScheduler({ backgroundIdleMs: 5000 });
		scheduler.enqueue(tick);
		assert.equal(scheduler.take(1000), null);
		scheduler.enqueue(speech);
		scheduler.take(2000);
		assert.equal(scheduler.take(3000), null);
		assert.equal(scheduler.take(7001)?.kind, "clock.tick");
	});

	it("returns null when empty", () => {
		const scheduler = new AttentionScheduler({ backgroundIdleMs: 0 });
		assert.equal(scheduler.take(0), null);
		assert.equal(scheduler.size("realtime"), 0);
	});
});
