/**
 * 用模型做分档与提炼（ADR-0014 的 classifier / distiller 注入点）。
 *
 * 两条约束写在这里，不指望调用方自觉：
 * 1. 只读对话本身 —— 输出必须是 JSON，字段超纲就丢；quote 不落在原文里就当没有；
 * 2. 失败一律回落 —— 超时、空回复、坏 JSON 都返回 undefined，交给 archive.ts 的规则兜底，
 *    记忆链路不能因为一次网关抽风就停摆。
 */

import type { Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ArchiveOptions, MemoryDraft, RawTurn, TierDecision } from "./archive.ts";
import { LOCAL_API_KEY, MAGPIE_REASONING_EFFORT, magpieModel } from "./model.ts";

export interface DistillOptions {
	/** 网关模型 id，默认沿用 `magpieModel()` 的规则。 */
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	maxTokens?: number;
	/** 测试缝：直接给「prompt → 文本」。生产环境走 Magpie。 */
	complete?: (prompt: string, call: { system: string }) => Promise<string>;
	/** 出错时的观察口（默认静默，避免把网关噪声打进 stdout）。 */
	onError?: (error: unknown) => void;
}

const CLASSIFY_SYSTEM = "你是一个记忆分档器。只输出 JSON，不要解释，不要代码块。";
const DISTILL_SYSTEM = "你是一个记忆提炼器。只输出 JSON，不要解释，不要代码块。";

const TIERS: readonly TierDecision["tier"][] = ["ordinary", "medium", "critical"];
const MAX_DRAFTS = 5;
const MAX_TEXT = 60;
const MAX_QUOTE = 120;

function renderTurns(turns: readonly RawTurn[]): string {
	const lines = turns
		.filter((turn) => turn.role !== "system")
		.map((turn) => (turn.role === "user" ? "用户：" : "伊里斯：") + turn.content.trim());
	const joined = lines.join("\n");
	// 只喂最近的一段：更早的内容已经在别的轮次里提炼过了。
	return joined.length > 4000 ? joined.slice(joined.length - 4000) : joined;
}

function classifyPrompt(turns: readonly RawTurn[]): string {
	return [
		"判断这段对话值得被记到什么程度。",
		"",
		"判据：",
		"- critical：用户明确要求记住，或涉及过敏 / 疾病 / 用药 / 重要日期 / 承诺 / 安全；",
		"- medium：跨多轮的约定、稳定偏好、长期计划；",
		"- ordinary：一次性闲聊、天气、随口一句话。",
		"宁可判低，不要判高：判成 critical 的记忆以后只能由人改。",
		"",
		'只输出：{"tier":"ordinary|medium|critical","reason":"不超过 20 字的理由"}',
		"",
		"对话：",
		renderTurns(turns),
	].join("\n");
}

function distillPrompt(turns: readonly RawTurn[], tier: TierDecision["tier"]): string {
	return [
		"把这段对话里值得被记住的事实，写成 IRIS 自己会记得的短句。",
		"",
		"规则：",
		"1. 只写对话里明确说过的内容，不推测、不补充；",
		"2. 每条不超过 40 字，写成事实本身，不要写成「用户说……」；",
		"3. quote 必须从对话原文里原样摘一句，没有合适的就不写这个字段；",
		"4. 最多 " + MAX_DRAFTS + " 条，没有值得记的就输出空数组；",
		tier === "critical"
			? "5. 这条是重要记忆，必须把它最核心的那一件事写清楚。"
			: "5. 宁少不多，能一句话说清就不要拆成两条。",
		"",
		'只输出：{"memories":[{"text":"...","quote":"...","importance":0.6,"tags":["..."]}]}',
		"",
		"对话：",
		renderTurns(turns),
	].join("\n");
}

/** 去掉模型爱加的代码块围栏和前后废话，只留 JSON 主体。 */
function jsonBody(raw: string): string {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence?.[1] !== undefined) text = fence[1];
	const start = text.search(/[[{]/);
	if (start < 0) return "";
	text = text.slice(start);
	const last = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	return last < 0 ? "" : text.slice(0, last + 1);
}

function clip(value: string, limit: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

/** 解析分档结果；字段不合规就返回 undefined，让 archive 回落规则。 */
export function parseTier(raw: string): TierDecision | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonBody(raw));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { tier?: unknown; reason?: unknown };
	const tier = TIERS.find((candidate) => candidate === record.tier);
	if (tier === undefined) return undefined;
	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0 ? clip(record.reason, 40) : "模型判断";
	return { tier, reason, source: "model" };
}

/** 解析提炼结果：quote 必须是原文子串，否则丢掉；text 超长截断。 */
export function parseDrafts(raw: string, source: string): readonly MemoryDraft[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonBody(raw));
	} catch {
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { memories?: unknown }).memories)
			? (parsed as { memories: unknown[] }).memories
			: [];
	const drafts: MemoryDraft[] = [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as { text?: unknown; quote?: unknown; importance?: unknown; tags?: unknown };
		if (typeof record.text !== "string") continue;
		const text = clip(record.text, MAX_TEXT);
		if (text.length < 2) continue;
		const draft: MemoryDraft = { text };
		if (typeof record.quote === "string") {
			const quote = clip(record.quote, MAX_QUOTE);
			if (quote.length > 1 && source.includes(quote)) draft.quote = quote;
		}
		if (typeof record.importance === "number" && Number.isFinite(record.importance)) {
			draft.importance = Math.min(1, Math.max(0, record.importance));
		}
		if (Array.isArray(record.tags)) {
			const tags = record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 4);
			if (tags.length > 0) draft.tags = tags;
		}
		drafts.push(draft);
		if (drafts.length >= MAX_DRAFTS) break;
	}
	return drafts;
}

/** 走 Magpie 的一次性补全：不开思考、temperature 0、失败不重试（调用方会回落规则）。 */
function magpieComplete(options: DistillOptions): (prompt: string, call: { system: string }) => Promise<string> {
	const model = magpieModel({ model: options.model, baseUrl: options.baseUrl });
	const apiKey = options.apiKey ?? LOCAL_API_KEY;
	const callOptions: SimpleStreamOptions = {
		apiKey,
		temperature: 0,
		maxTokens: options.maxTokens ?? 512,
		timeoutMs: options.timeoutMs ?? 20_000,
		maxRetries: 0,
		samplingParams: { reasoning_effort: MAGPIE_REASONING_EFFORT },
	};
	return async (prompt, call) => {
		const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
		const context: Context = { systemPrompt: call.system, messages };
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
	};
}

/** 分档器：失败返回 undefined，`SqliteArchive.classify()` 会回落到规则。 */
export function llmClassifier(options: DistillOptions = {}): NonNullable<ArchiveOptions["classifier"]> {
	const complete = options.complete ?? magpieComplete(options);
	return async ({ turns }) => {
		try {
			return parseTier(await complete(classifyPrompt(turns), { system: CLASSIFY_SYSTEM }));
		} catch (error) {
			options.onError?.(error);
			return undefined;
		}
	};
}

/** 提炼器：失败或产出为空都返回 undefined，`finishConversation()` 会回落到摘要。 */
export function llmDistiller(options: DistillOptions = {}): NonNullable<ArchiveOptions["distiller"]> {
	const complete = options.complete ?? magpieComplete(options);
	return async ({ turns, tier }) => {
		try {
			const drafts = parseDrafts(
				await complete(distillPrompt(turns, tier), { system: DISTILL_SYSTEM }),
				renderTurns(turns),
			);
			return drafts.length > 0 ? drafts : undefined;
		} catch (error) {
			options.onError?.(error);
			return undefined;
		}
	};
}

/** 一起接上。用法：`new SqliteArchive({ path, ...llmMemory() })`。 */
export function llmMemory(options: DistillOptions = {}): {
	classifier: NonNullable<ArchiveOptions["classifier"]>;
	distiller: NonNullable<ArchiveOptions["distiller"]>;
} {
	return { classifier: llmClassifier(options), distiller: llmDistiller(options) };
}
