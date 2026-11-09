/**
 * 上下文压缩：涨到窗口边上就把最旧的一段收进记忆（ADR-0023）。
 *
 * 和 pi 的 coding-agent 压缩不是一回事：那边压成一份「技术摘要」塞回上下文，
 * 这边压成一条**记忆**落进 archive——她的记忆每轮都在 system prompt 里，
 * 所以丢掉的原文不是消失，是变成「她还记得」。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateTokens, type RawTurn } from "./archive.ts";
import { type CompleteFn, completeText } from "./complete.ts";
import { MAGPIE_MODEL } from "./model.ts";

/** 给「这一轮请求 + 回复」留的余量，与 pi 的 reserveTokens 同一个默认值。 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** 最近这段原文保留多少 token 不压。 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** 一张图按这么多 token 算（pi 的 CHARS_PER_IMAGE / 4）。 */
const TOKENS_PER_IMAGE = 1_200;

const SUMMARY_SYSTEM = "你在替一个人整理她自己的聊天记录。只写发生过的事，不评价、不发挥。";

const SUMMARY_PROMPT = [
	"下面是你们之前的一段聊天。把它收成一小段**你自己的记述**，供你以后回想。",
	"",
	"要求：",
	"- 用第一人称，像自己在记事，不要写成报告或提纲",
	"- 只写发生过的事、说过的关键话，不要解释、不要总结情绪",
	"- 保留具体的东西：名字、数字、约定、他明确说过的事",
	"- 200 字以内，只输出这一段",
	"",
	"聊天记录：",
].join("\n");

export interface Consolidation {
	/** 收成记忆的那段话。 */
	summary: string;
	/** 被压掉的原文（已经交出去，调用方可再存一份）。 */
	turns: readonly RawTurn[];
	tokensBefore: number;
	tokensAfter: number;
}

export interface CompactionOptions {
	/** 模型的上下文窗口。默认取 magpieModel() 的 128k。 */
	contextWindow?: number;
	/** 留多少给请求本身。默认 16384。 */
	reserveTokens?: number;
	/** 最近这么多 token 的原文不压。默认 20000。 */
	keepRecentTokens?: number;
	/** 构造历史消息时记的模型 id。 */
	model?: string;
	/** 换掉「怎么收成一段话」。 */
	complete?: CompleteFn;
	/** 收进记忆时的回调（会话层用它写 archive）。 */
	onConsolidate?: (result: Consolidation) => void | Promise<void>;
	clock?: () => number;
}

export interface CompactionStats {
	/** 压过几次。 */
	count: number;
	/** 最近一次压之前 / 之后的估算 token。 */
	lastTokensBefore: number;
	lastTokensAfter: number;
}

/** 一条消息占多少 token（正文按 archive 的口径，图按 1200）。 */
export function estimateMessageTokens(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return estimateTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const kind = (block as { type?: string }).type;
		if (kind === "text") tokens += estimateTokens(String((block as { text?: string }).text ?? ""));
		else if (kind === "thinking") tokens += estimateTokens(String((block as { thinking?: string }).thinking ?? ""));
		else if (kind === "image") tokens += TOKENS_PER_IMAGE;
	}
	return tokens;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return tokens;
}

function roleOf(message: AgentMessage): string {
	return (message as { role?: string }).role ?? "unknown";
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		if ((block as { type?: string }).type === "text") parts.push(String((block as { text?: string }).text ?? ""));
	}
	return parts.join("");
}

/** 兜底：模型不可用时，直接把原文按行截断拼一段，不能因此抛错。 */
export function plainSummary(turns: readonly RawTurn[], limit = 600): string {
	const lines: string[] = [];
	for (const turn of turns) {
		const speaker = turn.role === "assistant" ? "我" : "他";
		const text = turn.content.replace(/\s+/g, " ").trim();
		if (text.length === 0) continue;
		lines.push(speaker + "：" + (text.length > 60 ? text.slice(0, 59) + "…" : text));
	}
	const joined = lines.join("；");
	return joined.length <= limit ? joined : joined.slice(0, limit - 1) + "…";
}

function noteMessage(summary: string, model: string, at: number): Message {
	const note: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "（更早的聊天我记着了：" + summary + "）" }],
		api: "openai-completions",
		provider: "magpie",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: at,
	};
	return note;
}

export class ContextCompactor {
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
	private readonly model: string;
	private readonly summarize: CompleteFn;
	private readonly onConsolidate: ((result: Consolidation) => void | Promise<void>) | undefined;
	private readonly clock: () => number;
	private stats: CompactionStats = { count: 0, lastTokensBefore: 0, lastTokensAfter: 0 };

	constructor(options: CompactionOptions = {}) {
		this.contextWindow = options.contextWindow ?? 128_000;
		this.reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
		this.keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
		this.model = options.model ?? MAGPIE_MODEL;
		this.summarize =
			options.complete ??
			((prompt, call) => completeText(prompt, { system: call.system, maxTokens: 400, timeoutMs: 30_000 }));
		this.onConsolidate = options.onConsolidate;
		this.clock = options.clock ?? Date.now;
	}

	/** 这次请求塞得下的上限。 */
	get budget(): number {
		return Math.max(1_000, this.contextWindow - this.reserveTokens);
	}

	get state(): CompactionStats {
		return { ...this.stats };
	}

	/**
	 * 交给 pi 的 transformContext：超预算就把最旧的一段收进记忆，然后返回新的消息列表。
	 * 不抛错——压不动就原样交回去，让 pi 自己去撞窗口。
	 */
	async compact(messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
		let current = [...messages];
		let before = estimateMessagesTokens(current);
		if (before <= this.budget) return current;

		for (let round = 0; round < 3; round += 1) {
			const cut = this.cutPoint(current);
			if (cut <= 0) break;
			const dropped = current.slice(0, cut);
			const kept = current.slice(cut);
			const turns = this.turnsOf(dropped);
			if (turns.length === 0) break;
			const summary = await this.summarizeSpan(turns);
			const note = noteMessage(summary, this.model, this.clock());
			const next = [note, ...kept];
			const after = estimateMessagesTokens(next);
			this.stats = { count: this.stats.count + 1, lastTokensBefore: before, lastTokensAfter: after };
			if (this.onConsolidate !== undefined) {
				try {
					await this.onConsolidate({ summary, turns, tokensBefore: before, tokensAfter: after });
				} catch {
					// 记忆写不进去不能连带毁掉这一轮
				}
			}
			current = next;
			before = after;
			if (after <= this.budget) break;
		}
		return current;
	}

	/** 从最新往回累，累到 keepRecentTokens 就停；留下的必须从「他」说的话开始。 */
	private cutPoint(messages: readonly AgentMessage[]): number {
		let kept = 0;
		let index = messages.length;
		while (index > 0) {
			const previous = messages[index - 1];
			if (previous === undefined) break;
			const tokens = estimateMessageTokens(previous);
			if (kept + tokens > this.keepRecentTokens) break;
			kept += tokens;
			index -= 1;
		}
		// 至少要压掉一点、也至少要留最后两条，否则这轮压不出东西
		index = Math.min(index, messages.length - 2);
		while (index < messages.length && roleOf(messages[index] ?? ({} as AgentMessage)) !== "user") index += 1;
		return Math.min(index, messages.length - 2);
	}

	private turnsOf(messages: readonly AgentMessage[]): readonly RawTurn[] {
		const turns: RawTurn[] = [];
		for (const message of messages) {
			const role = roleOf(message);
			if (role !== "user" && role !== "assistant") continue;
			const content = textOf(message).trim();
			if (content.length === 0) continue;
			const at = (message as { timestamp?: number }).timestamp ?? this.clock();
			turns.push({ role: role as RawTurn["role"], content, at });
		}
		return turns;
	}

	private async summarizeSpan(turns: readonly RawTurn[]): Promise<string> {
		const prompt =
			SUMMARY_PROMPT +
			"\n" +
			turns.map((turn) => (turn.role === "assistant" ? "我：" : "他：") + turn.content).join("\n");
		let summary = "";
		try {
			summary = (await this.summarize(prompt, { system: SUMMARY_SYSTEM })).trim();
		} catch {
			summary = "";
		}
		if (summary.length === 0) summary = plainSummary(turns);
		// 压出来的东西不能比原文还长
		const sourceChars = turns.reduce((total, turn) => total + turn.content.length, 0);
		if (summary.length > Math.max(80, sourceChars)) summary = plainSummary(turns);
		return summary;
	}
}

export function createCompactor(options: CompactionOptions = {}): ContextCompactor {
	return new ContextCompactor(options);
}
