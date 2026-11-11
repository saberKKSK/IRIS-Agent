/**
 * 屏幕：把他眼前的画面变成几句话（ADR-0036）。
 *
 * 跟 vision.ts 的分工：那一层只负责「图 → 客观转述」，这一层负责「把屏幕抓成一张图」。
 * 抓拍优先走 ffmpeg 的 gdigrab（0.7 s 抓 + 缩 + 存 JPEG 一步到位），
 * 缩到 512 宽只剩 27 KB —— 全屏 1536×960 的 PNG 是 773 KB、转述要 18 s；512 宽 8.7 s。
 *
 * 为什么不用 PowerShell + System.Drawing 当主力：那条脚本（Add-Type + CopyFromScreen + Save）
 * 被 Defender 的 AMSI 判成 "This script contains malicious content"（2026-11-10 本机实测），
 * 整段脚本一行都执行不了。ffmpeg 是普通 exe，不经过 AMSI，所以留它当主力，
 * PowerShell 版留作没装 ffmpeg 时的退路。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { describeImage, imageBlock, loadImage, seesInline, type VisionNote } from "./vision.ts";

/** 缩略宽度：再小就看不出字了，再大就慢（512 宽 8.7 s / 768 宽 15.4 s / 原图 18.2 s）。 */
export const SCREEN_WIDTH = 512;

/**
 * 她自己看屏幕时用的宽度（ADR-0047）。
 *
 * 512 宽是给「转述」那条路定的——翻成几句话够用，但界面上的字全糊了，她自己看也读不出来。
 * 1600 宽、质量 80 大约 200 KB，抓拍本身不变慢（缩放在 ffmpeg 里一步做完），
 * 多出来的只有模型那边的 token。
 */
export const INLINE_SCREEN_WIDTH = 1600;
export const INLINE_SCREEN_QUALITY = 80;

/** JPEG 质量。65 时 512 宽约 29 KB，够看清版面和大字。 */
export const SCREEN_QUALITY = 65;

export const SCREEN_TIMEOUT_MS = 20_000;

/** 问法必须收口：hy4free 是思考型，问「屏幕上有什么」会陷在 reasoning 里收不了尾。 */
export const DEFAULT_SCREEN_PROMPT = "他在干什么？三句以内，只说看到的，别描述界面布局。";

export const DEFAULT_SCREEN_SYSTEM = "你在替一个看不见屏幕的人看一眼。照实说，别添，别评价。";

/** 缩到 512 宽之后小字必然糊，凡是读出来的数字都得打个问号。 */
export const SCREEN_CAVEAT = "（截的是缩略图，小字和数字可能看错）";

export interface CapturedFrame {
	path: string;
	bytes: number;
	width: number;
	height: number;
	ms: number;
}

export interface CaptureOptions {
	/** 存到哪，默认临时目录下的一张固定名字的 jpg（每次覆盖）。 */
	path?: string;
	width?: number;
	quality?: number;
	timeoutMs?: number;
}

export type CaptureFn = (options?: CaptureOptions) => Promise<CapturedFrame>;

/** 转述这一段单独开个缝：默认实现自己把图读进来，测试就不用落盘了。 */
export type DescribeFn = (frame: CapturedFrame, options?: { prompt?: string; system?: string }) => Promise<VisionNote>;

export interface CaptureError {
	ok: false;
	error: string;
}

function captureScript(width: number, quality: number): string {
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
		"$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
		"$g = [System.Drawing.Graphics]::FromImage($full)",
		"$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
		"$g.Dispose()",
		"$w = " + String(width),
		"$h = [int]($full.Height * $w / $full.Width)",
		"$small = New-Object System.Drawing.Bitmap $w, $h",
		"$g2 = [System.Drawing.Graphics]::FromImage($small)",
		"$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
		"$g2.DrawImage($full, 0, 0, $w, $h)",
		"$g2.Dispose()",
		"$full.Dispose()",
		"$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
		"$ep = New-Object System.Drawing.Imaging.EncoderParameters 1",
		"$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, " +
			String(quality) +
			")",
		"$small.Save($env:IRIS_SCREEN_OUT, $codec, $ep)",
		"$small.Dispose()",
	].join("; ");
}

interface ShellRun {
	code: number | null;
	stdout: string;
	stderr: string;
	failed: boolean;
}

function runPowerShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<ShellRun> {
	return new Promise((resolve) => {
		const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
			windowsHide: true,
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (result: ShellRun): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			done({ code: null, stdout, stderr: stderr + "（抓拍超时）", failed: true });
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => done({ code: null, stdout, stderr: stderr + error.message, failed: true }));
		child.on("close", (code: number | null) => done({ code, stdout, stderr, failed: code !== 0 }));
	});
}

/** 默认落在系统临时目录，不占仓库、不占家目录。 */
export function defaultScreenPath(): string {
	return join(tmpdir(), "iris-screen", "frame.jpg");
}

/** 找 ffmpeg：先看 IRIS_FFMPEG，再问 where.exe，最后认几个常见安装位置。 */
export function findFfmpeg(): string | null {
	const pinned = process.env.IRIS_FFMPEG?.trim() ?? "";
	if (pinned.length > 0 && existsSync(pinned)) return pinned;
	const where = spawnSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true });
	const hit = (where.stdout ?? "")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && existsSync(line));
	if (hit !== undefined) return hit;
	const local = process.env.LOCALAPPDATA ?? "";
	if (local.length > 0) {
		const links = join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
		if (existsSync(links)) return links;
	}
	return null;
}

/** 抓屏用 ffmpeg 的 gdigrab：抓、缩、编码一步做完，0.7 s 出 27 KB 的 JPEG。 */
function captureWithFfmpeg(
	ffmpeg: string,
	path: string,
	width: number,
	quality: number,
	timeoutMs: number,
): Promise<ShellRun> {
	return new Promise((resolve) => {
		// -q:v 反过来：数字越大越糊。65 质量约等于 -q:v 6。
		const q = String(Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29))));
		const child = spawn(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"gdigrab",
				"-framerate",
				"1",
				"-i",
				"desktop",
				"-frames:v",
				"1",
				"-vf",
				`scale=${String(width)}:-1`,
				"-q:v",
				q,
				"-y",
				path,
			],
			{ windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (result: ShellRun): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			done({ code: null, stdout, stderr: stderr + "（抓拍超时）", failed: true });
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => done({ code: null, stdout, stderr: stderr + error.message, failed: true }));
		child.on("close", (code: number | null) => done({ code, stdout, stderr, failed: code !== 0 }));
	});
}

/**
 * 抓一张当前的屏幕，缩到 width 宽存 JPEG。
 *
 * 只支持 Windows：先找 ffmpeg（gdigrab），找不到再退回 PowerShell + System.Drawing
 * （那条在开了 AMSI 的机器上可能整段被判成恶意脚本）。
 */
export async function captureScreen(options: CaptureOptions = {}): Promise<CapturedFrame> {
	if (process.platform !== "win32") throw new Error("现在只能抓 Windows 的屏幕");
	const path = options.path ?? defaultScreenPath();
	const width = options.width ?? SCREEN_WIDTH;
	const quality = options.quality ?? SCREEN_QUALITY;
	const timeoutMs = options.timeoutMs ?? SCREEN_TIMEOUT_MS;
	mkdirSync(path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"))), { recursive: true });
	const started = Date.now();
	const ffmpeg = findFfmpeg();
	const run =
		ffmpeg === null
			? await runPowerShell(captureScript(width, quality), { IRIS_SCREEN_OUT: path }, timeoutMs)
			: await captureWithFfmpeg(ffmpeg, path, width, quality, timeoutMs);
	if (run.failed) {
		const why = run.stderr.trim().split("\n")[0] ?? "";
		throw new Error("没抓到屏幕" + (why.length === 0 ? "" : "：" + why));
	}
	const size = statSync(path).size;
	if (size === 0) throw new Error("抓到的图是空的");
	return { path, bytes: size, width, height: 0, ms: Date.now() - started };
}

export interface ScreenToolDetails {
	ok: boolean;
	action: "look";
	path?: string;
	bytes?: number;
	captureMs?: number;
	visionMs?: number;
	lines?: number;
	/** true = 图直接给了她看；false = 走的 hy4free 转述那条老路。 */
	inline?: boolean;
	error?: string;
}

export interface ScreenToolOptions {
	/** 测试缝：换掉抓拍。 */
	capture?: CaptureFn;
	/** 测试缝：换掉转述。 */
	describe?: DescribeFn;
	width?: number;
	quality?: number;
	/** 她自己是看图还是听转述（ADR-0047）。不给就跟着 `IRIS_VISION` 走。 */
	vision?: "inline" | "describe";
}

function failed(message: string, path?: string): AgentToolResult<ScreenToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { ok: false, action: "look", ...(path === undefined ? {} : { path }), error: message },
		isError: true,
	};
}

/** 一句话问法：他给了问题就按他的问题问，没给就用默认那句。 */
function promptFor(question: string | undefined): string {
	const asked = question?.trim() ?? "";
	if (asked.length === 0) return DEFAULT_SCREEN_PROMPT;
	return asked + "（就答这一句，三句以内，只说你看到的）";
}

/** 给她一只看屏幕的眼睛：一件 look_at_screen。 */
export function screenTools(options: ScreenToolOptions = {}): AgentTool[] {
	const capture = options.capture ?? captureScreen;
	const inline = options.vision === "inline" ? true : options.vision === "describe" ? false : seesInline();
	const describe: DescribeFn =
		options.describe ??
		(async (frame, call) =>
			await describeImage(loadImage(frame.path), {
				...(call?.prompt === undefined ? {} : { prompt: call.prompt }),
				...(call?.system === undefined ? {} : { system: call.system }),
			}));

	const look: AgentTool = {
		name: "look_at_screen",
		label: "看一眼屏幕",
		description: inline
			? "看他现在屏幕上的画面（整块屏幕的截图，图会直接给你看）。他让你看屏幕、问你在看什么、他自己描述屏幕上的东西时用它。截图本身一秒多，但还是别连着看——看一眼就够，看完直接说你看到了什么。"
			: "看他现在屏幕上的画面（整块屏幕，缩略图）。他让你看屏幕、问你在看什么、他自己描述屏幕上的东西时用它。慢，一次 8 到 18 秒，别连着看第二眼；看一眼就说你看到了什么，别报界面细节。",
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "你想从这张屏幕上知道什么（比如「他在玩什么游戏」「图里那行报错写的什么」），可省。",
				},
			},
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<ScreenToolDetails>> => {
			const args = params as { question?: unknown };
			const question = typeof args.question === "string" ? args.question : undefined;
			let frame: CapturedFrame;
			try {
				// 她自己看时要给足分辨率，不然界面上的字她读不出来（ADR-0047）。
				const width = options.width ?? (inline ? INLINE_SCREEN_WIDTH : undefined);
				const quality = options.quality ?? (inline ? INLINE_SCREEN_QUALITY : undefined);
				frame = await capture(
					width === undefined && quality === undefined
						? undefined
						: {
								...(width === undefined ? {} : { width }),
								...(quality === undefined ? {} : { quality }),
							},
				);
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
			if (inline) {
				try {
					const seen = loadImage(frame.path);
					return {
						content: [
							{
								type: "text",
								text:
									"他此刻的屏幕就在这条结果里（缩到 " +
									frame.width +
									" 宽），你自己看" +
									(question === undefined ? "" : "：" + question),
							},
							imageBlock(seen),
						],
						details: {
							ok: true,
							action: "look",
							path: frame.path,
							bytes: frame.bytes,
							captureMs: frame.ms,
							visionMs: 0,
							lines: 0,
							inline: true,
						},
					};
				} catch (error) {
					return failed(error instanceof Error ? error.message : String(error), frame.path);
				}
			}
			let note: VisionNote;
			try {
				note = await describe(frame, { prompt: promptFor(question), system: DEFAULT_SCREEN_SYSTEM });
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error), frame.path);
			}
			return {
				content: [{ type: "text", text: note.text + "\n" + SCREEN_CAVEAT }],
				details: {
					ok: true,
					action: "look",
					path: frame.path,
					bytes: frame.bytes,
					captureMs: frame.ms,
					visionMs: note.latencyMs,
					lines: note.text.length,
					inline: false,
				},
			};
		},
	};

	return [look];
}
