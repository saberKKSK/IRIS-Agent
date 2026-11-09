/** 走 Magpie 的一次性补全：不开思考、temperature 0、失败不重试（调用方自己回落）。 */

import type { Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { LOCAL_API_KEY, MAGPIE_REASONING_EFFORT, magpieModel } from "./model.ts";

export interface CompleteOptions {
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	maxTokens?: number;
	temperature?: number;
	maxRetries?: number;
	/** system prompt；不给就空字符串。 */
	system?: string;
}

/** 测试缝：把「prompt → 文本」固定住。 */
export type CompleteFn = (prompt: string, call: { system: string }) => Promise<string>;

export async function completeText(prompt: string, options: CompleteOptions = {}): Promise<string> {
	const model = magpieModel({ model: options.model, baseUrl: options.baseUrl });
	const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	const context: Context = { systemPrompt: options.system ?? "", messages };
	const callOptions: SimpleStreamOptions = {
		apiKey: options.apiKey ?? LOCAL_API_KEY,
		temperature: options.temperature ?? 0,
		maxTokens: options.maxTokens ?? 512,
		timeoutMs: options.timeoutMs ?? 20_000,
		maxRetries: options.maxRetries ?? 0,
		samplingParams: { reasoning_effort: MAGPIE_REASONING_EFFORT },
	};
	const stream = await streamSimple(model, context, callOptions);
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
	}
	const final = await stream.result();
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		throw new Error(final.errorMessage ?? "model stream failed");
	}
	if (text.trim().length > 0) return text;
	return final.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
