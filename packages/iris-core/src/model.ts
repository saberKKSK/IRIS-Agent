/**
 * 本机 Magpie 网关的模型描述。
 *
 * 请求组装、鉴权头、SSE 解析、重试、usage 记账全部由 pi-ai 完成；这个文件只回答一个问题：
 * 「IRIS 现在跟谁说话」。换网关改这里，不碰会话层。
 */

import type { Model } from "@earendil-works/pi-ai";

/** DeepSeek 的 reasoning 预算。none 让首字落在 1 s 内，realtime 车道需要这个。 */
export type ModelReasoningEffort = "none" | "low" | "high";

/**
 * Magpie 跑在 loopback 上，不需要凭据；三个常量都可以用环境变量覆盖。
 * 路由组（auto/deepseek-v4.1-flash）在短回复上会先花 1.4-3.1 s 思考再经常什么都不吐，
 * 直连路线 + reasoning 关闭实测首字 871 ms。
 */
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";
export const MAGPIE_MODEL = "deepseek/deepseek-flash";
export const MAGPIE_REASONING_EFFORT: ModelReasoningEffort = "none";

/**
 * 眼睛用的模型。deepseek 系列在网关上收下图片后什么都不说（content 为空），
 * any/* 报 404「当前 API 不支持所选模型」，workbuddy 的 gpt-6-* / glm-5.3 报额度耗尽；
 * 只剩 hy4free 真能看图，免费，一张截图 5-9 s（ADR-0020）。
 */
export const MAGPIE_VISION_MODEL = "workbuddy-ai/hy4free";

/** Loopback 网关不校验鉴权，但 pi 的 OpenAI 客户端要求非空 key。 */
export const LOCAL_API_KEY = "magpie";

/** 眼睛：同一个网关，换一个能看图的模型，并声明它收图。 */
export function visionModel(options: { model?: string; baseUrl?: string } = {}): Model<"openai-completions"> {
	const id = options.model ?? process.env.MAGPIE_VISION_MODEL ?? MAGPIE_VISION_MODEL;
	return {
		id,
		name: `Magpie · ${id}`,
		api: "openai-completions",
		provider: "magpie",
		baseUrl: options.baseUrl ?? process.env.MAGPIE_BASE_URL ?? MAGPIE_BASE_URL,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 2_048,
	};
}

/** 把 Magpie 描述成 pi 的 model，交给 pi-ai 的 OpenAI 兼容适配器。 */
export function magpieModel(options: { model?: string; baseUrl?: string } = {}): Model<"openai-completions"> {
	const id = options.model ?? process.env.MAGPIE_MODEL ?? MAGPIE_MODEL;
	return {
		id,
		name: `Magpie · ${id}`,
		api: "openai-completions",
		provider: "magpie",
		baseUrl: options.baseUrl ?? process.env.MAGPIE_BASE_URL ?? MAGPIE_BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}
