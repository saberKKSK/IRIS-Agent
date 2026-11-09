/**
 * IRIS 的会话层：一轮对话整包交给 pi-agent-core 的 `Agent`。
 *
 * 这里不写自己的循环。多轮上下文、工具调用、重试、steering、中断、事件流都在
 * `Agent` / `agentLoop` 里（ADR-0011）；本文件只做四件事：
 * 1. 把四层人格（persona / state / relationship / memory）编译成 transcript 第一条 system 消息；
 * 2. 给出一个直接打本机 Magpie 的 StreamFn（reasoning_effort=none，首字 <1 s）；
 * 3. 把 pi 的 `AgentEvent` 摊平成三车道能消费的 `IrisSessionEvent`；
 * 4. 一轮结束后把对话写回 Episode、推进关系状态。
 */

import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
	MemoryRecord,
	RawTurn,
	RecallOptions,
	RecallResult,
	SqliteArchive,
	StyleRecord,
	TierDecision,
} from "./archive.ts";
import { renderMemories } from "./archive.ts";
import { type CompactionOptions, type Consolidation, type ContextCompactor, createCompactor } from "./context.ts";
import type { InMemoryMemoryStore } from "./memory.ts";
import {
	LOCAL_API_KEY,
	MAGPIE_MODEL,
	MAGPIE_REASONING_EFFORT,
	type ModelReasoningEffort,
	magpieModel,
} from "./model.ts";
import { buildSystemPrompt, chatify, stripStageDirections, stripTrailingPeriods } from "./persona.ts";
import { renderStyle } from "./style.ts";
import type { Episode, Persona, PersonaState, Relationship } from "./types.ts";
import type { DescribeOptions, VisionImage, VisionNote } from "./vision.ts";
import { describeImage, loadImage } from "./vision.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RECENT = 5;
const DEFAULT_MEMORY_LIMIT = 6;
const DEFAULT_RESUME_MESSAGES = 200;
/** 0 = 不限时间：同一个会话就是同一段对话，不分「隔了一天」。 */
const DEFAULT_RESUME_WINDOW_MS = 0;
/** 接回历史的字符预算（约 24k 字 ≈ 12k token），超了从最旧的开始丢。 */
const DEFAULT_RESUME_CHARS = 24_000;

/** pi 的 usage 归一化后的三个计数。 */
export interface IrisUsage {
	promptTokens: number;
	completionTokens: number;
	/** Reasoning tokens，网关报告时才有（是 completionTokens 的子集）。 */
	reasoningTokens?: number;
}

/** 一轮结束后的结果，够写日志、够喂 TTS、够算延迟预算。 */
export interface IrisTurn {
	text: string;
	reasoning: string;
	model: string;
	usage: IrisUsage;
	/** 首个内容增量的毫秒数。 */
	firstTokenMs: number;
	/** 整轮毫秒数。 */
	latencyMs: number;
	stopReason: string;
	/** 本轮写回记忆的片段；没有记忆库时为 null。 */
	episode: Episode | null;
}

/** 三车道的消费面：realtime 用 delta，async 用 tool，background 用 turn_end。 */
export type IrisSessionEvent =
	| { type: "turn_start" }
	| { type: "reasoning"; text: string }
	| { type: "delta"; text: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; elapsedMs?: number }
	| { type: "turn_end"; turn: IrisTurn }
	/** 上下文压过一次：最旧的一段收成了记忆（ADR-0023）。 */
	| { type: "compact"; dropped: number; tokensBefore: number; tokensAfter: number; summary: string }
	| { type: "error"; message: string };

export interface IrisSessionHooks {
	onEvent?(event: IrisSessionEvent): void;
}

/** 模型侧的失败。pi 把错误编码进流，这里把它翻回异常，好让上层重试或降级。 */
export class IrisSessionError extends Error {
	readonly stopReason: string;

	constructor(message: string, stopReason = "error") {
		super(message);
		this.name = "IrisSessionError";
		this.stopReason = stopReason;
	}
}

export interface IrisSessionOptions {
	persona: Persona;
	state?: PersonaState;
	relationship?: Relationship;
	memory?: InMemoryMemoryStore;
	/** 原文归档 + 三档记忆（ADR-0014）。给了就在每轮结束后把原文落库。 */
	archive?: SqliteArchive;
	/** 重建 system prompt 时回看的记忆条数。默认 5。 */
	recentLimit?: number;
	/** 开场注入的长期记忆条数（重要档优先）。默认 6。 */
	memoryLimit?: number;
	/** 重启后接回来的原文条数上限（一问一答算两条）。默认 200；0 = 不接。 */
	resumeMessages?: number;
	/** 只接这么久以内的。默认 0 = 不限——同一个会话就是同一段对话。 */
	resumeWindowMs?: number;
	/** 接回历史的字符预算。默认 24 000 字（约 12k token），超了从最旧的开始丢。 */
	resumeChars?: number;
	/** 复用上一次的会话行，而不是每次启动新开一条。默认 true（ADR-0022）。 */
	reuseConversation?: boolean;
	/** 用哪份语料风格档案；不填就用库里当前生效的那份。 */
	styleName?: string;
	/** 外部人格文档（Markdown 原文）。给了就用它顶替模板里的「## 你是谁」。 */
	personaDoc?: string;
	/** 允许人格文档用括号写动作/旁白。默认关闭（语音优先，旁白会被念出来）。 */
	stageDirections?: boolean;
	/** 标点风格：`chat`（默认）句尾不留句号，`prose` 保留。 */
	punctuation?: "chat" | "prose";
	/** 网关模型 id，默认 `deepseek/deepseek-flash`。 */
	model?: string;
	/** 网关根地址，含 `/v1`。 */
	baseUrl?: string;
	apiKey?: string;
	reasoningEffort?: ModelReasoningEffort;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	/** 上下文压缩（ADR-0023）。默认开；false 关掉；给对象可调阈值。 */
	compact?: boolean | CompactionOptions;
	/** 交给 pi 的工具；Phase 1 默认空。 */
	tools?: AgentTool[];
	/** 只读文件能看的根目录（真路径）。给了就写进 prompt，免得她拿「桌面」当字面路径去猜。 */
	lookRoots?: readonly string[];
	/** 写回记忆的默认标签。 */
	episodeTags?: readonly string[];
	/** 时间源，测试可注入。 */
	clock?: () => number;
	/** 会话级事件监听。 */
	onEvent?(event: IrisSessionEvent): void;
	/** 测试缝：替换 pi 的 StreamFn；生产环境用 streamSimple。 */
	streamFn?: StreamFn;
}

export interface MagpieStreamOptions {
	apiKey?: string;
	timeoutMs?: number;
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: ModelReasoningEffort;
	/**
	 * 每次请求现问一次：这一条要不要把工具逼出来。会话在「她要出去查」那一轮的第一条请求上
	 * 打开（见 `looksLikeLookup`），之后关掉——长历史下她太容易顺着聊天往下接，
	 * 嘴上说「搜过了」手却没动。
	 *
	 * 走 `samplingParams.tool_choice` 而不是 pi 的 `toolChoice` 字段：pi 只建模了
	 * `"auto" | "none"`（types.ts:136），而网关要的是 `"required"`；samplingParams 是
	 * 原样并进请求体、且在具名字段之后（openai-completions.ts:995），正好适合这种供应商参数。
	 */
	forceToolCall?: () => boolean;
}

const DEFAULT_STATE: PersonaState = {
	mood: { label: "calm", valence: 0, arousal: 0.3, updatedAt: 0 },
	energy: 0.7,
	activity: "待机",
	speaking: false,
};

function defaultRelationship(now: number): Relationship {
	return { closeness: 0.4, sharedMoments: 0, lastInteractionAt: now };
}

/**
 * 打本机 Magpie 的 StreamFn。
 * 用 `lazyStream` 包一层，是为了满足 pi 的契约「StreamFn 不许抛」：同步抛出的鉴权/连接错误
 * 会被翻成一个 error 事件 + stopReason: "error" 的 assistant 消息。
 */
export function magpieStreamFn(options: MagpieStreamOptions = {}): StreamFn {
	const apiKey = options.apiKey ?? LOCAL_API_KEY;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const reasoningEffort = options.reasoningEffort ?? MAGPIE_REASONING_EFFORT;
	return (model, context, callOptions) => {
		const forced = options.forceToolCall?.() === true;
		const request: SimpleStreamOptions = {
			...(callOptions ?? {}),
			apiKey,
			timeoutMs,
			samplingParams: {
				...callOptions?.samplingParams,
				reasoning_effort: reasoningEffort,
				...(forced ? { tool_choice: "required" } : {}),
			},
			...(options.temperature === undefined ? {} : { temperature: options.temperature }),
			...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		};
		return lazyStream(model, async () => streamSimple(model, context, request), undefined, request.signal);
	};
}

/**
 * 这句话是不是在让她去外面查点东西。
 *
 * 命中就这一轮的第一条请求带 `tool_choice: "required"`（ADR-0025）：长历史下她习惯顺着
 * 聊天往下接，光在 prompt 里写「要真的查」管不住——嘴上的「搜过了」不是工具调用。
 * 判据取窄一点：宁可少强制，也别把她明明知道答案的一句话推去上网。
 */
const LOOKUP_HINT =
	/搜一?下|搜一?搜|搜索|搜搜|查一下|查一查|查查|帮我查|帮我搜|上网查|网上查|最新消息|最新新闻|今天的新闻|天气|股价|汇率|比分|上映|多少钱|search|google|look\s*up/i;
/** 这些话是在问「我们自己」的事，不该往外搜。 */
const LOOKUP_VETO = /记忆|记住|我们上次|上次说|之前说|聊天记录|你自己说过|你记得/;

/** 强制查时附在输入后面那句提示的开头，用来在历史里认出来并摘掉。 */
const NUDGE_START = "\n\n（这一句是新问题";

/**
 * 附在输入后面的那句：只查这一句，别接着上一句查；顺带把今天的日期给她，
 * 否则她会给「今天天气」配一个凭空的日期（实测给成 2026 年 8 月）。
 * 导出给测试与排查用。
 */
export function lookupNudge(now: number): string {
	const date = new Date(now);
	const day = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
	return `${NUDGE_START}。要查就用这一句问的事去查，别拿上一句的题目去搜。今天是 ${day}，要带日期就带这个。）`;
}

/** 从文本里摘掉提示；只认末尾那一整段括号。 */
export function stripNudgeText(text: string): string {
	const index = text.lastIndexOf(NUDGE_START);
	if (index < 0) return text;
	const tail = text.slice(index).trimEnd();
	if (!tail.endsWith("）")) return text;
	return text.slice(0, index).trimEnd();
}

export function looksLikeLookup(text: string): boolean {
	const flat = text.trim();
	if (flat.length === 0) return false;
	if (LOOKUP_VETO.test(flat)) return false;
	return LOOKUP_HINT.test(flat);
}

/** 把强制查那句提示从一条消息里摘掉；用户消息的 content 可能是字符串或文本块数组。 */
function stripNudge(message: AgentMessage): AgentMessage {
	if (message.role !== "user") return message;
	const content = message.content;
	if (typeof content === "string") {
		const text = stripNudgeText(content);
		return text === content ? message : { ...message, content: text };
	}
	if (!Array.isArray(content)) return message;
	let changed = false;
	const blocks = content.map((block) => {
		if (block.type !== "text" || !block.text.includes(NUDGE_START)) return block;
		const text = stripNudgeText(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...message, content: blocks } : message;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return null;
}

/** 接回来的历史消息不是真跑出来的，用量记 0（每条一个对象，别共享同一份）。 */
function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function clip(value: string, limit: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * 一段会话 = 一个 pi `Agent` + 一份人格状态 + 一张记忆表。
 * 并发不需要使用者操心：`say()` 会先等上一轮说完；真要插话就用 `agent.steer()`。
 */
export class IrisSession {
	/** 逃生舱：需要 steer / followUp / 工具队列时直接用 pi 的原语。 */
	readonly agent: Agent;

	private readonly persona: Persona;
	private readonly personaDoc: string | undefined;
	private readonly stageDirections: boolean | undefined;
	private readonly punctuation: "chat" | "prose" | undefined;
	private readonly memory: InMemoryMemoryStore | null;
	private readonly archive: SqliteArchive | null;
	private conversationId: string | null = null;
	private readonly recentLimit: number;
	private readonly memoryLimit: number;
	private readonly resumeMessages: number;
	private readonly resumeWindowMs: number;
	private readonly resumeChars: number;
	private readonly reuseConversation: boolean;
	private readonly compactor: ContextCompactor | null;
	/** 工具名集合。prompt 里教哪几件事，看手上真有什么（ADR-0026：文件三件和联网是两套说法）。 */
	private readonly toolNames: Set<string>;
	/** 只读文件的起点，写进 prompt 用（ADR-0026 补丁：她原来不知道家目录长什么样）。 */
	private readonly lookRoots: readonly string[];
	private restoredCount = 0;
	private styleName: string | null;
	private readonly episodeTags: readonly string[];
	private readonly clock: () => number;
	private readonly listener: ((event: IrisSessionEvent) => void) | undefined;
	private bond: Relationship;
	private state: PersonaState;
	private hook: ((event: IrisSessionEvent) => void) | null = null;
	private runStartedAt = 0;
	private firstTokenMs = 0;
	private turns = 0;
	/** 这一轮还剩几条请求要强制带工具（0 = 不强制）。 */
	private forcedToolChoices = 0;
	/** 这一轮真的调过几次工具，用来判断她是不是又在嘴上说「搜过了」。 */
	private toolCallsThisTurn = 0;

	constructor(options: IrisSessionOptions) {
		this.persona = options.persona;
		this.personaDoc = options.personaDoc;
		this.stageDirections = options.stageDirections;
		this.punctuation = options.punctuation;
		this.memory = options.memory ?? null;
		this.archive = options.archive ?? null;
		this.recentLimit = options.recentLimit ?? DEFAULT_RECENT;
		this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
		this.resumeMessages = options.resumeMessages ?? DEFAULT_RESUME_MESSAGES;
		this.resumeWindowMs = options.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
		this.resumeChars = options.resumeChars ?? DEFAULT_RESUME_CHARS;
		this.reuseConversation = options.reuseConversation ?? true;
		this.styleName = options.styleName ?? null;
		this.episodeTags = options.episodeTags ?? ["对话"];
		this.clock = options.clock ?? Date.now;
		this.listener = options.onEvent;
		this.state = options.state ?? DEFAULT_STATE;
		this.bond = options.relationship ?? defaultRelationship(this.clock());

		// buildPrompt() 在 new Agent(...) 的参数里就会被调用，所以这些字段必须先定好。
		// 构造发生在 buildPrompt() 之前：prompt 里写「你能上网 / 你能看文件」要使真手上有的工具。
		this.toolNames = new Set((options.tools ?? []).map((tool) => tool.name));
		this.lookRoots = options.lookRoots ?? [];
		// 先把会话行定下来，再拿它接历史：重启复用的是同一条会话，不是又一条新的。
		this.conversationId = this.startConversation();
		const model = magpieModel(options);
		this.compactor = this.makeCompactor(model.contextWindow, options.compact);
		this.agent = new Agent({
			initialState: {
				systemPrompt: this.buildPrompt(),
				model,
				// reasoning 由网关参数控制（none），pi 自己的 thinkingLevel 关掉，避免双重请求。
				thinkingLevel: "off",
				tools: [...(options.tools ?? [])],
				// 上次没聊完的直接接上，不是从零开始（ADR-0021）。
				messages: this.restoreTranscript(options),
			},
			streamFn: options.streamFn ?? magpieStreamFn({ ...options, forceToolCall: () => this.takeForcedToolCall() }),
			// 每次请求前：把强制查那句提示从历史里摘掉，再按预算压缩（ADR-0023 / ADR-0025）。
			transformContext: (messages: readonly AgentMessage[]) => this.prepareHistory(messages),
		});
		this.agent.subscribe((event) => this.forward(event));
	}

	get model(): string {
		return this.agent.state.model.id;
	}

	/** 当前这条会话的 id。重启后还是同一条（ADR-0022）；没接归档层就是 null。 */
	get conversation(): string | null {
		return this.conversationId;
	}

	/** 这次启动接回来了几条原文（0 = 从头开始）。 */
	get restoredMessages(): number {
		return this.restoredCount;
	}

	/** 这次运行压过几次上下文、最近一次压成多少。 */
	get compactions(): { count: number; lastTokensBefore: number; lastTokensAfter: number } {
		return this.compactor === null ? { count: 0, lastTokensBefore: 0, lastTokensAfter: 0 } : this.compactor.state;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	get messages(): readonly AgentMessage[] {
		return this.agent.state.messages;
	}

	get personaState(): PersonaState {
		return this.state;
	}

	get relationship(): Relationship {
		return this.bond;
	}

	/** 当前生效的风格档案（没接归档层、或库里没导入过就是 null）。 */
	get style(): StyleRecord | null {
		if (this.archive === null) return null;
		return this.archive.style(this.styleName ?? undefined) ?? null;
	}

	/** 换一份语料风格，立刻重建 system prompt（历史保留）。 */
	useStyle(name: string): void {
		this.styleName = name;
		this.refreshPrompt();
	}

	/** 当前人格 prompt（每次按最新状态与记忆重编）。 */
	get systemPrompt(): string {
		return this.buildPrompt();
	}

	/** 改状态后调 `refreshPrompt()`，transcript 的第一条 system 消息会被替换。 */
	updateState(patch: Partial<PersonaState>): void {
		this.state = { ...this.state, ...patch };
	}

	/** 用最新的状态与记忆重编 system prompt；会话历史保留。 */
	refreshPrompt(): void {
		const system = createInitialSystemMessage(
			this.buildPrompt(),
			this.agent.state.tools.map((tool) => toToolDeclaration(tool)),
		);
		const rest = this.agent.state.messages.filter((message) => message.role !== "system");
		this.agent.state.messages = system === undefined ? rest : [system, ...rest];
	}

	/**
	 * 说一句话并等这一轮说完。
	 * 上一轮还在跑就先等它收尾（要打断用 `interrupt()`）。
	 */
	async say(input: string, hooks: IrisSessionHooks = {}): Promise<IrisTurn> {
		if (this.agent.state.isStreaming) await this.agent.waitForIdle();

		const startedAt = performance.now();
		this.runStartedAt = startedAt;
		this.firstTokenMs = 0;
		this.hook = hooks.onEvent ?? null;
		// 她要出去查，就把第一条请求的工具强制出来（ADR-0025）。只有一条：查出结果后照常说话。
		this.toolCallsThisTurn = 0;
		// 只有联网工具时强制一次工具调用；只给了文件工具时不逼她——那会变成被迫 ls 一遍。
		const lookup = this.toolNames.has("web_search") && looksLikeLookup(input);
		this.forcedToolChoices = lookup ? 1 : 0;
		// 强制出来的工具调用由模型决定搜什么。历史里挂着一句没答完的话时，它会照着旧题目搜，
		// 所以这里把「这一句是新问题」说清楚——只影响本轮发给模型的输入，归档的仍是原话。
		const promptInput = lookup ? input + lookupNudge(this.clock()) : input;
		const emit = (event: IrisSessionEvent): void => {
			this.listener?.(event);
			hooks.onEvent?.(event);
		};

		try {
			await this.agent.prompt(promptInput);
			await this.agent.waitForIdle();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.hook = null;
			emit({ type: "error", message });
			throw new IrisSessionError(message);
		}

		const message = lastAssistant(this.agent.state.messages);
		if (message === null) {
			this.hook = null;
			emit({ type: "error", message: "pi agent 没有产出 assistant 消息" });
			throw new IrisSessionError("pi agent 没有产出 assistant 消息");
		}

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const reason = message.errorMessage ?? "model stream failed";
			this.hook = null;
			emit({ type: "error", message: reason });
			throw new IrisSessionError(reason, message.stopReason);
		}

		let text = "";
		let reasoning = "";
		for (const block of message.content) {
			if (block.type === "text") text += block.text;
			else if (block.type === "thinking") reasoning += block.thinking;
		}

		if (this.stageDirections !== true) text = stripStageDirections(text);
		if (this.punctuation !== "prose") {
			text = chatify(stripTrailingPeriods(text));
		}

		const usage: IrisUsage = { promptTokens: message.usage.input, completionTokens: message.usage.output };
		if (message.usage.reasoning !== undefined) usage.reasoningTokens = message.usage.reasoning;

		const at = this.clock();
		const turn: IrisTurn = {
			text,
			reasoning,
			model: message.responseModel ?? message.model,
			usage,
			firstTokenMs: Math.round(this.firstTokenMs),
			latencyMs: Math.round(performance.now() - startedAt),
			stopReason: message.stopReason,
			episode: null,
		};

		this.bond = {
			...this.bond,
			sharedMoments: this.bond.sharedMoments + 1,
			lastInteractionAt: at,
		};

		if (this.memory !== null) {
			this.turns += 1;
			const episode: Episode = {
				id: `turn-${at}-${this.turns}`,
				at,
				kind: "conversation",
				summary: clip(`用户：${input} ／ ${this.persona.name}：${text}`, 180),
				tags: this.episodeTags,
				importance: 0.5,
			};
			this.memory.append(episode);
			turn.episode = episode;
		}

		this.archiveTurn(input, text, at);
		emit({ type: "turn_end", turn });
		this.hook = null;
		return turn;
	}

	/**
	 * 会话结束：按三档分类并把提炼条写进库（ADR-0014）。
	 * 没有归档层就返回 null，调用方不必分支。
	 */
	async endConversation(): Promise<{ tier: TierDecision; memories: readonly MemoryRecord[] } | null> {
		if (this.archive === null || this.conversationId === null) return null;
		const result = await this.archive.finishConversation(this.conversationId);
		this.conversationId = null;
		return result;
	}

	/** 需要回忆时才查（工具调用的落点）。没有归档层就返回 null。 */
	recall(query: string, options?: RecallOptions): RecallResult | null {
		if (this.archive === null) return null;
		return this.archive.recall(query, options);
	}

	/**
	 * 看一眼图：只拿转述，不把图塞进对话（ADR-0020）。
	 * 说话的人是 deepseek-flash，看不了图；这一步换 hy4free 当眼睛。
	 */
	async look(image: VisionImage | string, options: DescribeOptions = {}): Promise<VisionNote> {
		const loaded = typeof image === "string" ? loadImage(image) : image;
		return describeImage(loaded, options);
	}

	/**
	 * 对方发来一张图：先转述，再把转述交给她当对方说的话。
	 * 回复仍然由人格模型出 —— 眼睛和嘴不是一个模型，她照自己的脾气接。
	 */
	async sayAbout(image: VisionImage | string, hint = "", hooks: IrisSessionHooks = {}): Promise<IrisTurn> {
		const note = await this.look(image);
		return this.say(imageFrame(note, hint), hooks);
	}

	/** 打断当前这一轮（用户插话、关窗）。 */
	interrupt(): void {
		this.agent.abort();
	}

	/** 清空会话历史，保留人格与记忆。 */
	reset(): void {
		if (this.agent.state.isStreaming) return;
		this.agent.reset();
	}

	/** 原文落库：不脱敏的事交给 archive，这里只负责把这一轮原样交过去。 */
	private archiveTurn(input: string, reply: string, at: number): void {
		if (this.archive === null || this.conversationId === null) return;
		const turns: RawTurn[] = [
			{ role: "user", content: input, at },
			{ role: "assistant", content: reply, at },
		];
		this.archive.appendTurns(this.conversationId, turns);
	}

	/** 复用上一次的会话行；没有（或者关掉复用）就新开一条。 */
	private startConversation(): string | null {
		if (this.archive === null) return null;
		if (this.reuseConversation) {
			const existing = this.archive.latestConversation("iris");
			if (existing !== null) return existing;
		}
		return this.archive.openConversation("iris", this.clock());
	}

	/**
	 * 把历史裁到预算内：从最新往前留，超过条数或字符预算就停（ADR-0021 / ADR-0022）。
	 */
	private trimHistory(rows: readonly RawTurn[]): readonly RawTurn[] {
		let chars = 0;
		let start = rows.length;
		while (start > 0) {
			if (rows.length - start >= this.resumeMessages) break;
			const row = rows[start - 1];
			if (row === undefined) break;
			const next = chars + row.content.length;
			if (start < rows.length && next > this.resumeChars) break;
			chars = next;
			start -= 1;
		}
		return rows.slice(start);
	}

	/**
	 * 重启后接着上次聊：把库里的原文还原成 pi 的 transcript（ADR-0021）。
	 * 跨会话取最近的——老库里一条会话一段，接历史不该只看最后那一段。
	 * 开头若是助手的半句话，丢掉——从对方的话接起才自然。
	 */
	private restoreTranscript(options: IrisSessionOptions): AgentMessage[] {
		if (this.archive === null || this.resumeMessages <= 0) return [];
		const modelId = options.model ?? MAGPIE_MODEL;
		const since = this.resumeWindowMs > 0 ? this.clock() - this.resumeWindowMs : 0;
		const rows = this.trimHistory(this.archive.recentMessages(this.resumeMessages, since));
		const restored: AgentMessage[] = [];
		for (const row of rows) {
			if (row.role === "user") {
				restored.push({ role: "user", content: [{ type: "text", text: row.content }], timestamp: row.at });
			} else if (row.role === "assistant") {
				restored.push({
					role: "assistant",
					content: [{ type: "text", text: row.content }],
					api: "openai-completions",
					provider: "magpie",
					model: modelId,
					usage: emptyUsage(),
					stopReason: "stop",
					timestamp: row.at,
				});
			}
		}
		while (restored.length > 0 && restored[0]?.role === "assistant") restored.shift();
		this.restoredCount = restored.length;
		return restored;
	}

	/** 手上有只读文件三件里的任何一件（ADR-0026）。 */
	private hasFileTools(): boolean {
		return this.toolNames.has("ls") || this.toolNames.has("read") || this.toolNames.has("grep");
	}

	private buildPrompt(): string {
		const now = this.clock();
		const remembered = this.remembered(now);
		const selfFacts = this.selfFactLines();
		const style = this.styleText();
		return buildSystemPrompt({
			persona: this.persona,
			...(this.personaDoc === undefined ? {} : { portrait: this.personaDoc }),
			...(this.stageDirections === undefined ? {} : { stageDirections: this.stageDirections }),
			...(this.punctuation === undefined ? {} : { punctuation: this.punctuation }),
			state: this.state,
			relationship: this.bond,
			recent: this.memory?.recent(this.recentLimit) ?? [],
			...(remembered.length === 0 ? {} : { memories: remembered }),
			...(selfFacts.length === 0 ? {} : { selfFacts }),
			...(style === undefined ? {} : { style }),
			...(this.toolNames.has("web_search") ? { canSearch: true } : {}),
			...(this.hasFileTools() ? { canLook: true } : {}),
			...(this.hasFileTools() && this.lookRoots.length > 0 ? { lookRoots: this.lookRoots } : {}),
			now,
		});
	}

	/**
	 * 开场注入：把库里重要档与最近确认过的记忆带进 system prompt（ADR-0014 检索时刻①）。
	 * 没有归档层时为 0 条，行为与之前完全一致。
	 */
	private remembered(now: number): readonly string[] {
		if (this.archive === null) return [];
		const rows = this.archive.essential(this.memoryLimit);
		if (rows.length === 0) return [];
		return renderMemories(rows, now).split("\n");
	}

	/**
	 * 她自己的账（做过什么、得出过什么结果）。开场全量注入：别人转述她的过去时，
	 * 她得有一份自己的版本可以对照，否则喂什么说什么（ADR-0019）。
	 */
	private selfFactLines(): readonly string[] {
		if (this.archive === null) return [];
		return this.archive.selfFacts().map((fact) => fact.value);
	}

	/** 语料风格渲染成 prompt 段落；没导入过就返回 undefined。 */
	private styleText(): string | undefined {
		if (this.archive === null) return undefined;
		const record = this.archive.style(this.styleName ?? undefined);
		if (record === undefined) return undefined;
		const text = renderStyle(record.profile);
		return text.length === 0 ? undefined : text;
	}

	/** 上下文压缩器（ADR-0023）：关掉返回 null；仓库测试可以塞自己的 complete。 */
	private makeCompactor(
		contextWindow: number,
		compact: boolean | CompactionOptions | undefined,
	): ContextCompactor | null {
		if (compact === false) return null;
		const overrides: CompactionOptions = typeof compact === "object" ? compact : {};
		return createCompactor({
			contextWindow,
			...overrides,
			onConsolidate: overrides.onConsolidate ?? ((result) => this.consolidate(result)),
		});
	}

	/**
	 * pi 每次请求前都会叫这里：先摘掉强制查留下的那句提示（它只是这一次的脚注，
	 * 留在历史里她会当成对方一直在说），没超预算就原样放行。
	 */
	private async prepareHistory(messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
		const cleaned = messages.map((message) => stripNudge(message));
		if (this.compactor === null) return cleaned;
		return await this.compactor.compact(cleaned);
	}

	/**
	 * 压出来的那段：一半落进记忆（下次开场她自然想得起），一半报给三车道。
	 * 这里不刷 system prompt——运行中换掉第一条消息会把 prefix cache 全废掉。
	 */
	private consolidate(result: Consolidation): void {
		if (this.archive !== null) {
			this.archive.remember({ text: result.summary, tags: ["巩固"], importance: 0.55 });
		}
		this.emit({
			type: "compact",
			dropped: result.turns.length,
			tokensBefore: result.tokensBefore,
			tokensAfter: result.tokensAfter,
			summary: result.summary,
		});
	}

	private emit(event: IrisSessionEvent): void {
		this.listener?.(event);
		this.hook?.(event);
	}

	/** 给 magpieStreamFn 现问：这一轮用掉一次强制，之后照常。 */
	private takeForcedToolCall(): boolean {
		if (this.forcedToolChoices <= 0) return false;
		this.forcedToolChoices -= 1;
		return true;
	}

	/** pi 的事件面 → 三车道的信号。错误留给 `say()` 统一抛，不在这里双发。 */
	private forward(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start": {
				this.runStartedAt = performance.now();
				this.firstTokenMs = 0;
				this.emit({ type: "turn_start" });
				return;
			}
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "thinking_delta") {
					this.emit({ type: "reasoning", text: inner.delta });
				} else if (inner.type === "text_delta") {
					if (this.firstTokenMs === 0) this.firstTokenMs = performance.now() - this.runStartedAt;
					this.emit({ type: "delta", text: inner.delta });
				}
				return;
			}
			case "tool_execution_start": {
				this.toolCallsThisTurn += 1;
				this.emit({
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				return;
			}
			case "tool_execution_end": {
				this.emit({
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					...(event.durationMs === undefined ? {} : { elapsedMs: event.durationMs }),
				});
				return;
			}
			default:
				return;
		}
	}
}

/** 把「看到的东西」包成对方说的话：转述 + 用户可能附带的一句。 */
export function imageFrame(note: VisionNote, hint = ""): string {
	const tail = hint.trim().length > 0 ? "）" + hint.trim() : "）";
	return "（对方发来一张图，你看到的是：" + note.text + tail;
}

/** 建一段会话。 */
export function createSession(options: IrisSessionOptions): IrisSession {
	return new IrisSession(options);
}
