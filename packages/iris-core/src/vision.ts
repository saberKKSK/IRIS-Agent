/**
 * 眼睛：把一张图变成几句话（ADR-0020）。
 *
 * 说话的那个人（deepseek-flash）看不了图 —— 网关收下图片、返回 200，然后 content 是空的。
 * 网关上真正能看图的是 workbuddy-ai/hy4free。所以这一层只做一件事：
 * 图进来，客观转述出去；评价、情绪、怎么接话仍然交给会话层。
 */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Context, ImageContent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { LOCAL_API_KEY, MAGPIE_REASONING_EFFORT, visionModel } from "./model.ts";

/**
 * 问法只能这么朴素。hy4free 是思考型，问法里一出现「清单式要求」（什么图/谁在说话/有没有数字）
 * 或「这张图里是什么」这种开放问句，它就在 reasoning 里逐字统计、永远收不了尾 ——
 * 实测 1200 / 2400 两个预算都被思考吃干净、正文 0 字。换成「三句以内」这种收口要求后 8 s 出 233 字。
 */
export const DEFAULT_VISION_PROMPT = "说说这张图里有什么，三句以内。别逐句抄。";

export const DEFAULT_VISION_SYSTEM = "你在替一个看不见图的人看图。照实说，别添，别评价。";

/** 转述的预算：思考占大头，正文只有几十字，1200 够用；撞上 length 会自动翻倍。 */
export const DEFAULT_VISION_TOKENS = 1_200;

/** 单张图上限，超了宁可报错也不悄悄截断。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

export interface VisionImage {
	data: string;
	mimeType: string;
}

/**
 * 这张图本身，直接塞进消息里给她看（ADR-0047）。
 *
 * pi 的 user 消息与 toolResult 都收 ImageContent，OpenAI 适配器会把它转成
 * `{type:"image_url", url:"data:<mime>;base64,…"}`——和本机网关收得下的格式一致。
 */
export function imageBlock(image: VisionImage): ImageContent {
	return { type: "image", data: image.data, mimeType: image.mimeType };
}

/**
 * 她现在是自己看，还是老样子听转述。
 *
 * 2026-11-11 实测网关的 deepseek-flash 能看图了，所以默认把图直接给她；
 * 模型换回不能看图的、或者想省 token 时，设 `IRIS_VISION=describe` 退回
 * hy4free 转述那条老路（ADR-0020）。
 */
export function seesInline(): boolean {
	const how = process.env.IRIS_VISION?.trim().toLowerCase();
	return how !== "describe" && how !== "off" && how !== "0";
}

/** 一眼之后留下的东西：转述文本 + 够算预算的计数。 */
export interface VisionNote {
	text: string;
	model: string;
	latencyMs: number;
	bytes: number;
	promptTokens: number;
	completionTokens: number;
}

export interface DescribeOptions {
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	/** 换掉「这张图里是什么」那句问法。 */
	prompt?: string;
	system?: string;
	maxTokens?: number;
	timeoutMs?: number;
	/** 测试缝：替换 pi 的 streamSimple。 */
	stream?: VisionStreamFn;
}

/** 只取用得上的那几个字段，好让测试给出假流。 */
export interface VisionChunk {
	type: string;
	delta?: string;
}

export interface VisionStreamResult {
	content: readonly { type: string; text?: string }[];
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number };
	model?: string;
}

export type VisionStream = AsyncIterable<VisionChunk> & { result(): Promise<VisionStreamResult> };

export type VisionStreamFn = (
	model: Model<"openai-completions">,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<VisionStream>;

export function mimeOf(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
}

/** 这个路径是不是一张看得懂的图。read 拿它决定走文本还是走眼睛。 */
export function isImagePath(path: string): boolean {
	return MIME_BY_EXT[extname(path).toLowerCase()] !== undefined;
}

/** 读图成 base64。空文件与超限直接抛，不静默降级。 */
export function loadImage(path: string): VisionImage {
	const size = statSync(path).size;
	if (size === 0) throw new Error("图片是空文件：" + path);
	if (size > MAX_IMAGE_BYTES) {
		throw new Error(
			"图片太大（" + Math.round(size / 1024) + " KB），上限 " + Math.round(MAX_IMAGE_BYTES / 1024) + " KB：" + path,
		);
	}
	return { data: readFileSync(path).toString("base64"), mimeType: mimeOf(path) };
}

interface Attempt {
	text: string;
	stopReason: string;
	errorMessage?: string;
	model?: string;
	usage?: { input: number; output: number };
}

/**
 * 一张图 → 一段客观转述。
 *
 * hy4free 是思考型：先吐几百字 reasoning 才给正文。预算给小了会撞上 length、正文一个字都没有
 * （实测 max_tokens 700 时正好卡在这）。所以正文为空且是 length 收尾时，加一倍预算再来一次。
 */
export async function describeImage(image: VisionImage, options: DescribeOptions = {}): Promise<VisionNote> {
	const model = visionModel({ model: options.model, baseUrl: options.baseUrl });
	const started = performance.now();
	const content: (ImageContent | { type: "text"; text: string })[] = [
		{ type: "image", data: image.data, mimeType: image.mimeType },
		{ type: "text", text: options.prompt ?? DEFAULT_VISION_PROMPT },
	];
	const context: Context = {
		systemPrompt: options.system ?? DEFAULT_VISION_SYSTEM,
		messages: [{ role: "user", content, timestamp: Date.now() }],
	};
	const run: VisionStreamFn = options.stream ?? (streamSimple as unknown as VisionStreamFn);
	const budget = options.maxTokens ?? DEFAULT_VISION_TOKENS;

	const attempt = async (maxTokens: number): Promise<Attempt> => {
		const request: SimpleStreamOptions = {
			apiKey: options.apiKey ?? LOCAL_API_KEY,
			temperature: 0.2,
			maxTokens,
			timeoutMs: options.timeoutMs ?? 90_000,
			maxRetries: 0,
			samplingParams: { reasoning_effort: MAGPIE_REASONING_EFFORT },
		};
		const stream = await run(model, context, request);
		let text = "";
		for await (const chunk of stream) {
			if (chunk.type === "text_delta" && typeof chunk.delta === "string") text += chunk.delta;
		}
		const final = await stream.result();
		if (text.trim().length === 0) {
			text = final.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
		}
		return {
			text: text.trim(),
			stopReason: final.stopReason,
			...(final.errorMessage === undefined ? {} : { errorMessage: final.errorMessage }),
			...(final.model === undefined ? {} : { model: final.model }),
			...(final.usage === undefined ? {} : { usage: { input: final.usage.input, output: final.usage.output } }),
		};
	};

	let result = await attempt(budget);
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? "视觉模型没有返回");
	}
	if (result.text.length === 0 && result.stopReason === "length") result = await attempt(budget * 2);
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? "视觉模型没有返回");
	}
	if (result.text.length === 0) throw new Error("视觉模型什么都没说（这张图可能超出它的能力）");

	return {
		text: result.text,
		model: result.model ?? model.id,
		latencyMs: Math.round(performance.now() - started),
		bytes: Buffer.byteLength(image.data, "base64"),
		promptTokens: result.usage?.input ?? 0,
		completionTokens: result.usage?.output ?? 0,
	};
}
