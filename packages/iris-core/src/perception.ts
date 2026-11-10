/**
 * 感知：隔一会儿看一眼屏幕，攒成「他现在在干什么」（ADR-0037）。
 *
 * 为什么要这一层：screen.ts 是「叫我看我才看」的一次性抓拍，agent 说话时才知道他在干嘛；
 * 陪伴要的是反过来 —— 她一直知道他在干什么，到合适的时机自己开口。
 *
 * 成本控制靠两层：
 * ① 每 tick 只抓一张 32×20 的灰度缩略图（ffmpeg rawvideo 走管道，约 0.25 s），跟上一帧逐像素比均值差；没变就不叫视觉模型。
 * ② 真变了（或太久没更新）才抓 512 宽 JPEG 让视觉模型说几句（约 9 s）。
 * 实测：静态屏幕连抓两次均值差 0.02，开一个记事本窗口 145.38 —— 阈值放在 8 分得很开。
 *
 * 为什么不用文件字节哈希判变化：同一张静态屏连抓两次，JPEG 一个 2484 B 一个 2378 B，md5 不同（桌面有亚克力模糊）。
 */

import { spawn } from "node:child_process";
import {
	type CapturedFrame,
	type CaptureFn,
	captureScreen,
	type DescribeFn,
	defaultScreenPath,
	SCREEN_WIDTH,
} from "./screen.ts";
import { describeImage, loadImage, type VisionNote } from "./vision.ts";

/** 缩略图尺寸：32×20 = 640 字节灰度，够分清「换了窗口」和「没动」。 */
export const FIT_WIDTH = 32;
export const FIT_HEIGHT = 20;

/** 均值差超过这个数就算换过画面（实测静态 0.02、开窗口 145）。 */
export const CHANGE_THRESHOLD = 8;

/** 多久抓一次缩略图，默认 20 s。 */
export const WATCH_INTERVAL_MS = 20_000;

/** 画面一直没变也要隔这么久重新描述一次，默认 3 分钟。 */
export const REFRESH_MS = 180_000;

/** 描述超过这么久就算过期，注入时明说「N 分钟前看的」。 */
export const STALE_MS = 600_000;

/** 一次描述的结果。 */
export interface Seen {
	/** 描述出来的时刻。 */
	at: number;
	/** 视觉模型说的那几句。 */
	note: string;
	/** 跟上一帧的均值差（第一次看是 255）。 */
	change: number;
}

export interface WatchOptions {
	/** 多久抓一次缩略图。 */
	intervalMs?: number;
	/** 变化阈值。 */
	changeThreshold?: number;
	/** 没变化也重新描述的时间。 */
	refreshMs?: number;
	/** 多久算过期。 */
	staleMs?: number;
	/** 描述用多宽的图。 */
	width?: number;
	/** 问视觉模型什么（空串就用默认问法）。 */
	question?: string;
	/** 测试缝：抓一张 512 图。 */
	capture?: CaptureFn;
	/** 测试缝：描述一张图。 */
	describe?: DescribeFn;
	/** 测试缝：抓 32×20 灰度缩略图。 */
	fit?: () => Promise<Buffer>;
	/** 测试缝：时钟。 */
	now?: () => number;
	/** 描述更新时回调（REPL 用来打印「（她看了一眼屏幕）」）。 */
	onNote?: (seen: Seen) => void;
}

/** 抓一张 FIT_WIDTH×FIT_HEIGHT 的灰度图，走 rawvideo 管道：不解码、不落盘，约 0.25 s。 */
export function fitScreen(ffmpeg: string = "ffmpeg"): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"gdigrab",
			"-i",
			"desktop",
			"-frames:v",
			"1",
			"-vf",
			"scale=" + String(FIT_WIDTH) + ":" + String(FIT_HEIGHT) + ",format=gray",
			"-f",
			"rawvideo",
			"pipe:1",
		];
		const child = spawn(ffmpeg, args, { windowsHide: true });
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			reject(error);
		});
		child.on("close", (code: number | null) => {
			const buffer = Buffer.concat(chunks);
			if (code !== 0 || buffer.length !== FIT_WIDTH * FIT_HEIGHT) {
				const why = stderr.trim().split("\n")[0] ?? "";
				reject(new Error("缩略图没抓到" + (why === "" ? "" : "：" + why)));
				return;
			}
			resolve(buffer);
		});
	});
}

/** 两帧的均值差（0–255）。 */
export function frameDiff(a: Buffer, b: Buffer): number {
	if (a.length === 0 || a.length !== b.length) return 255;
	let sum = 0;
	for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

/** 把时间说成「刚刚 / N 分钟前 / N 小时前」。 */
export function agoText(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "刚刚";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return String(minutes) + " 分钟前";
	return String(Math.round(minutes / 60)) + " 小时前";
}

/**
 * 一直看着屏幕的人：每 intervalMs 抓一张缩略图，画面变了才让视觉模型描述。
 */
export class ScreenWatcher {
	private readonly intervalMs: number;
	private readonly threshold: number;
	private readonly refreshMs: number;
	private readonly staleMs: number;
	private readonly width: number;
	private readonly question: string;
	private readonly capture: CaptureFn;
	private readonly describe: DescribeFn;
	private readonly fit: () => Promise<Buffer>;
	private readonly clock: () => number;
	private readonly onNote: ((seen: Seen) => void) | undefined;
	private lastFit: Buffer | null = null;
	private current: Seen | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;
	private tickCount = 0;
	private lookCount = 0;

	constructor(options: WatchOptions = {}) {
		this.intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
		this.threshold = options.changeThreshold ?? CHANGE_THRESHOLD;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.staleMs = options.staleMs ?? STALE_MS;
		this.width = options.width ?? SCREEN_WIDTH;
		this.question = options.question ?? "";
		this.capture = options.capture ?? captureScreen;
		this.describe =
			options.describe ??
			(async (frame: CapturedFrame, call?: { prompt?: string }) => {
				const options2 = call?.prompt === undefined ? {} : { prompt: call.prompt };
				return await describeImage(loadImage(frame.path), options2);
			});
		this.fit = options.fit ?? (() => fitScreen());
		this.clock = options.now ?? Date.now;
		this.onNote = options.onNote;
	}

	/** 最近一次描述；还没看过是 null。 */
	get latest(): Seen | null {
		return this.current;
	}

	/** 抓过几次缩略图、真的描述过几次（成本看这两个数）。 */
	get stats(): { ticks: number; looks: number } {
		return { ticks: this.tickCount, looks: this.lookCount };
	}

	/** 注入用的那一行；没有就 null。 */
	noteFor(now: number = this.clock()): string | null {
		if (this.current === null) return null;
		const age = now - this.current.at;
		const stale = age > this.staleMs;
		return (
			"他屏幕上是：" +
			this.current.note +
			"（" +
			agoText(this.current.at, now) +
			(stale ? "，可能已经变了" : "") +
			"）"
		);
	}

	/** 从某个时刻之后描述更新过没有（主动开口用它判断「值不值得说话」）。 */
	changedSince(at: number): boolean {
		return this.current !== null && this.current.at >= at;
	}

	/** 开始看着（立刻先看一次）。 */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		this.timer.unref?.();
		void this.tick();
	}

	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** 走一次判断（start() 的每一拍就是它；测试与手动排查也用它）。 */
	async poll(): Promise<void> {
		await this.tick(false);
	}

	/** 手动叫它现在看一眼。 */
	async peek(): Promise<Seen | null> {
		await this.tick(true);
		return this.current;
	}

	private async tick(force = false): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			this.tickCount += 1;
			let frame: Buffer | null = null;
			try {
				frame = await this.fit();
			} catch {
				frame = null;
			}
			const change = frame === null || this.lastFit === null ? 255 : frameDiff(this.lastFit, frame);
			if (frame !== null) this.lastFit = frame;
			const due = this.current === null || this.clock() - this.current.at >= this.refreshMs;
			if (!force && !due && change < this.threshold) return;
			await this.look(change);
		} finally {
			this.busy = false;
		}
	}

	private async look(change: number): Promise<void> {
		try {
			const frame = await this.capture({ path: defaultScreenPath(), width: this.width });
			const note = await this.describe(frame, this.question === "" ? {} : { prompt: this.question });
			const text = note.text.trim();
			if (text.length === 0) return;
			this.lookCount += 1;
			this.current = { at: this.clock(), note: text, change };
			this.onNote?.(this.current);
		} catch {
			// 抓不到 / 模型不回：这一 tick 就当没看见，下一 tick 再说。
		}
	}
}
