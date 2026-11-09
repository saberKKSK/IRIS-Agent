/** Lane assignment and the three-lane scheduler: realtime answers now, async thinks, background notices. */

import type { Lane, PerceptionEvent } from "./types.ts";

/** Maps one perception event to the lane that may consume it. */
export function laneFor(event: PerceptionEvent): Lane {
	switch (event.kind) {
		case "user.speech":
		case "device.presence":
			return "realtime";
		case "user.look":
		case "game.state":
			return "async";
		case "clock.tick":
		case "user.idle":
			return "background";
	}
}

export interface AttentionSchedulerOptions {
	/** Background work only runs after the foreground has been quiet for this long. */
	backgroundIdleMs: number;
}

export class AttentionScheduler {
	private readonly realtimeQueue: PerceptionEvent[] = [];
	private readonly asyncQueue: PerceptionEvent[] = [];
	private readonly backgroundQueue: PerceptionEvent[] = [];
	private readonly backgroundIdleMs: number;
	private lastForegroundAt: number;

	constructor(options: AttentionSchedulerOptions) {
		this.backgroundIdleMs = options.backgroundIdleMs;
		this.lastForegroundAt = 0;
	}

	enqueue(event: PerceptionEvent): void {
		this.queueFor(laneFor(event)).push(event);
	}

	/** Takes the highest-priority pending event, or null when nothing is due. Realtime starves async, background waits for silence. */
	take(now: number): PerceptionEvent | null {
		const foreground = this.realtimeQueue.shift() ?? this.asyncQueue.shift();
		if (foreground !== undefined) {
			this.lastForegroundAt = now;
			return foreground;
		}
		if (now - this.lastForegroundAt < this.backgroundIdleMs) return null;
		return this.backgroundQueue.shift() ?? null;
	}

	size(lane: Lane): number {
		return this.queueFor(lane).length;
	}

	private queueFor(lane: Lane): PerceptionEvent[] {
		if (lane === "realtime") return this.realtimeQueue;
		if (lane === "async") return this.asyncQueue;
		return this.backgroundQueue;
	}
}
