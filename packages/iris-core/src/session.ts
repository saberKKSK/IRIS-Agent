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
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { MemoryRecord, RawTurn, RecallOptions, RecallResult, SqliteArchive, TierDecision } from "./archive.ts";
import { renderMemories } from "./archive.ts";
import type { InMemoryMemoryStore } from "./memory.ts";
import { LOCAL_API_KEY, MAGPIE_REASONING_EFFORT, type ModelReasoningEffort, magpieModel } from "./model.ts";
import { buildSystemPrompt } from "./persona.ts";
import type { Episode, Persona, PersonaState, Relationship } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RECENT = 5;
const DEFAULT_MEMORY_LIMIT = 6;

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
	/** 网关模型 id，默认 `deepseek/deepseek-flash`。 */
	model?: string;
	/** 网关根地址，含 `/v1`。 */
	baseUrl?: string;
	apiKey?: string;
	reasoningEffort?: ModelReasoningEffort;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	/** 交给 pi 的工具；Phase 1 默认空。 */
	tools?: AgentTool[];
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
		const request: SimpleStreamOptions = {
			...(callOptions ?? {}),
			apiKey,
			timeoutMs,
			samplingParams: { ...callOptions?.samplingParams, reasoning_effort: reasoningEffort },
			...(options.temperature === undefined ? {} : { temperature: options.temperature }),
			...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		};
		return lazyStream(model, async () => streamSimple(model, context, request), undefined, request.signal);
	};
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return null;
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
	private readonly memory: InMemoryMemoryStore | null;
	private readonly archive: SqliteArchive | null;
	private conversationId: string | null = null;
	private readonly recentLimit: number;
	private readonly memoryLimit: number;
	private readonly episodeTags: readonly string[];
	private readonly clock: () => number;
	private readonly listener: ((event: IrisSessionEvent) => void) | undefined;
	private bond: Relationship;
	private state: PersonaState;
	private hook: ((event: IrisSessionEvent) => void) | null = null;
	private runStartedAt = 0;
	private firstTokenMs = 0;
	private turns = 0;

	constructor(options: IrisSessionOptions) {
		this.persona = options.persona;
		this.memory = options.memory ?? null;
		this.archive = options.archive ?? null;
		this.recentLimit = options.recentLimit ?? DEFAULT_RECENT;
		this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
		this.episodeTags = options.episodeTags ?? ["对话"];
		this.clock = options.clock ?? Date.now;
		this.listener = options.onEvent;
		this.state = options.state ?? DEFAULT_STATE;
		this.bond = options.relationship ?? defaultRelationship(this.clock());

		this.agent = new Agent({
			initialState: {
				systemPrompt: this.buildPrompt(),
				model: magpieModel(options),
				// reasoning 由网关参数控制（none），pi 自己的 thinkingLevel 关掉，避免双重请求。
				thinkingLevel: "off",
				tools: [...(options.tools ?? [])],
				messages: [],
			},
			streamFn: options.streamFn ?? magpieStreamFn(options),
		});
		this.agent.subscribe((event) => this.forward(event));
		this.conversationId = this.archive?.openConversation("iris", this.clock()) ?? null;
	}

	get model(): string {
		return this.agent.state.model.id;
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
		const emit = (event: IrisSessionEvent): void => {
			this.listener?.(event);
			hooks.onEvent?.(event);
		};

		try {
			await this.agent.prompt(input);
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

	private buildPrompt(): string {
		const now = this.clock();
		const remembered = this.remembered(now);
		return buildSystemPrompt({
			persona: this.persona,
			state: this.state,
			relationship: this.bond,
			recent: this.memory?.recent(this.recentLimit) ?? [],
			...(remembered.length === 0 ? {} : { memories: remembered }),
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

	private emit(event: IrisSessionEvent): void {
		this.listener?.(event);
		this.hook?.(event);
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

/** 建一段会话。 */
export function createSession(options: IrisSessionOptions): IrisSession {
	return new IrisSession(options);
}
