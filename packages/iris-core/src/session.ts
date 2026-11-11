/**
 * IRIS 的会话层：一轮对话整包交给 pi-agent-core 的 `Agent`。
 *
 * 这里不写自己的循环。多轮上下文、工具调用、重试、steering、中断、事件流都在
 * `Agent` / `agentLoop` 里（ADR-0011）；本文件只做四件事：
 * 1. 把四层人格（persona / state / relationship / memory）编译成 transcript 第一条 system 消息；
 * 2. 给出一个直接打本机 Magpie 的 StreamFn（默认 reasoning_effort=high，强制工具那轮压 none）；
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
import {
	chooseEffort,
	type EffortEnvelope,
	type EffortJudgement,
	type EffortOptions,
	type IrisEffort,
} from "./effort.ts";
import { ExpressionStream, splitExpression } from "./expression.ts";
import type { InMemoryMemoryStore } from "./memory.ts";
import {
	DEFAULT_SESSION_EFFORT,
	LOCAL_API_KEY,
	MAGPIE_MODEL,
	type ModelReasoningEffort,
	magpieModel,
} from "./model.ts";
import {
	buildSystemPrompt,
	chatify,
	dayStamp,
	momentNote,
	stripStageDirections,
	stripTrailingPeriods,
} from "./persona.ts";
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
	/** 这一轮她想摆的表情 id（ADR-0041），没写就是 null。 */
	expression: string | null;
	reasoning: string;
	model: string;
	usage: IrisUsage;
	/** 首个内容增量的毫秒数。 */
	firstTokenMs: number;
	/** 整轮毫秒数。 */
	latencyMs: number;
	stopReason: string;
	/** 这一轮用的思考档（ADR-0031）；自动档位关着就是配置里那个。 */
	effort: IrisEffort;
	/** 这一轮写回记忆的片段；没有记忆库时为 null。 */
	episode: Episode | null;
}

/** 三车道的消费面：realtime 用 delta，async 用 tool，background 用 turn_end。 */
export type IrisSessionEvent =
	| { type: "turn_start" }
	| { type: "reasoning"; text: string }
	| { type: "delta"; text: string }
	/** 字幕里写着 `<脸红>`：壳子收到就把脸换过去（ADR-0041）。 */
	| { type: "expression"; id: string }
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
	/** 壳子会画脸（ADR-0041）：开了她才在正文里写 `<脸红>`；默认开，标记不会进字幕和归档。 */
	expressions?: boolean;
	/** 网关模型 id，默认 `deepseek/deepseek-flash`。 */
	model?: string;
	/** 网关根地址，含 `/v1`。 */
	baseUrl?: string;
	apiKey?: string;
	reasoningEffort?: ModelReasoningEffort;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	/**
	 * 这一轮该想多深（ADR-0031）。默认 false = 恒 none；true 就按规则/分类模型现算，
	 * 顺带认「接着干没干完的活」。
	 */
	autoEffort?: boolean;
	/** 自动档位的细则（要不要问分类模型、兜底档、置信阈值）。 */
	effort?: EffortOptions;
	/** 上下文压缩（ADR-0023）。默认开；false 关掉；给对象可调阈值。 */
	compact?: boolean | CompactionOptions;
	/** 交给 pi 的工具；Phase 1 默认空。 */
	tools?: AgentTool[];
	/** 只读文件能看的根目录（真路径）。给了就写进 prompt，免得她拿「桌面」当字面路径去猜。 */
	lookRoots?: readonly string[];
	/** 他放开给她写的文件夹（真路径）；跟 lookRoots 是两本账（ADR-0034）。 */
	writeRoots?: readonly string[];
	/** 她能跑命令的文件夹（真路径）；默认就是能写的那几个（ADR-0035）。 */
	shellRoots?: readonly string[];
	/** 名单上能回私信的人（ADR-0029）；只在不传 tools 时才需要，传了 douyin_im 就自动点亮。 */
	dmNames?: readonly string[];
	/** 写回记忆的默认标签。 */
	episodeTags?: readonly string[];
	/**
	 * 感知层给的一行「他现在在干什么」（ADR-0037）。每次请求现问一次，贴在对方那句话后面；
	 * 没接感知层就不贴。返回 null 表示还没有可用的描述。
	 */
	perception?: () => string | null;
	/**
	 * 她此刻的心情，一行话（ADR-0044）。壳子里情绪是每帧在变的（apps/desktop/src/mood.ts 的
	 * VAD + 残留），所以内核每轮现问一次，贴在对方那句话末尾——不写进 system prompt：
	 * 那里一改就把 prefix cache 全废掉，而且心情一直在变，写死等于给她一个假的自己。
	 * 返回 null 表示这一刻没什么好说的（心情平了就闭嘴，别每轮都报「我心情平静」）。
	 */
	mood?: () => string | null;
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
	/**
	 * 每次请求现问一次：这一条用哪档思考（ADR-0031）。会话按轮决策后从这里读，
	 * 一轮里的后续请求（工具回来再问一次）复用同一个档。
	 */
	effort?: () => ModelReasoningEffort;
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
	const reasoningEffort = options.reasoningEffort ?? DEFAULT_SESSION_EFFORT;
	return (model, context, callOptions) => {
		const forced = options.forceToolCall?.() === true;
		// 强制工具那一轮必须关思考：思考模式下网关不支持 tool_choice: "required"。
		const effort = forced ? "none" : (options.effort?.() ?? reasoningEffort);
		const request: SimpleStreamOptions = {
			...(callOptions ?? {}),
			apiKey,
			timeoutMs,
			samplingParams: {
				...callOptions?.samplingParams,
				reasoning_effort: effort,
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
/** 让她去看私信时那句提示的开头（ADR-0029 的同类问题：嘴上说「我去看看」不算）。 */
const DM_NUDGE_START = "\n\n（这一句是让你去看私信";
/** 上一轮她自己说要查、这一轮同意了：这句提示开头同样以「这一句是」起手，方便摘历史。 */
const PROMISE_NUDGE_START = "\n\n（这一句是让你去把上一条答应的事查掉";
/** 两种提示共有的前缀，摘历史时认它。 */
const NUDGE_PREFIX = "\n\n（这一句是";

/**
 * 她自己开口时那条 cue 的开头。刻意不用 NUDGE_PREFIX：这句要留在历史里，
 * 否则下次她看见「自己说过的话」却不知道为什么说，像凭空冒出来。
 */
const SELF_START = "\n\n（你自己开口：";

/** 这句是在问私信。 */
const DM_HINT = /私信|私聊|谁给我发|给我发|谁找我|有什么消息|消息记录|未读|\bdm\b/i;

/**
 * 附在输入后面的那句：只查这一句，别接着上一句查。
 * 日期不再写在这里——每轮末尾都有现读本机时钟的 momentNote（ADR-0030 修订）。
 * 导出给测试与排查用。
 */
export function lookupNudge(): string {
	return `${NUDGE_START}。要查就用这一句问的事去查，别拿上一句的题目去搜。日期看末尾那句时间。）`;
}

/** 从文本里摘掉提示；只认末尾那一整段括号。 */
export function stripNudgeText(text: string): string {
	const index = text.lastIndexOf(NUDGE_PREFIX);
	if (index < 0) return text;
	const tail = text.slice(index).trimEnd();
	if (!tail.endsWith("）")) return text;
	return text.slice(0, index).trimEnd();
}

/** 答应过要查、对方点头了：这一句就是去查，别再问一遍。 */
export function promiseNudge(): string {
	return `${PROMISE_NUDGE_START}。你自己上一句说要去查，这一句是同意。现在就去调 web_search，查完再说结论。）`;
}

/** 让她去看私信时附的那句：点名用 douyin_im，没看到就说没看到。 */
export function dmNudge(): string {
	return `${DM_NUDGE_START}。要用 douyin_im 把名单上的人真看一遍，再说看到了什么；没看到就说没看到，别猜别编。）`;
}

/** 她上一条自己说要查（「要不我查一下？」）。下一句只要是同意，就得真去查。 */
const PROMISE_LOOKUP = /查一下|查查|我去查|我去搜|搜一下|上网查|网上查|帮你查|给你查|要不要我查/;

/** 只表示同意的短句（可以叠：「嗯嗯，查吧」）。 */
const AGREE_WORD = "(?:嗯+|好+|行|对|是|查吧|你查|去吧|要|可以|ok|okay)";
const AGREE_ONLY = new RegExp(`^\\s*${AGREE_WORD}(?:[，,、~～\\s]*${AGREE_WORD})*[。.!！?？~～\\s]*$`, "iu");

/**
 * 上一句她答应要去查、这一句是同意——把这句变成「现在就去调工具」。
 *
 * 实测：她答「我没瞎说 / 要不我查一下？」，对方说「嗯」，她直接回「查了，周四」，
 * 一次工具都没调。嘴上说查了不算（ADR-0025 的同一个病，只是触发词藏在上一轮）。
 */
export function looksLikePromiseAgreement(reply: string | null, input: string): boolean {
	if (reply === null) return false;
	if (!PROMISE_LOOKUP.test(reply)) return false;
	return AGREE_ONLY.test(input.trim());
}

export function looksLikeDm(text: string): boolean {
	const flat = text.trim();
	if (flat.length === 0) return false;
	return DM_HINT.test(flat);
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
		if (block.type !== "text" || !block.text.includes(NUDGE_PREFIX)) return block;
		const text = stripNudgeText(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...message, content: blocks } : message;
}

/**
 * 把时间戳接在最后一条用户消息后面（新起一个文本块，原文一个字不动）。
 * 只盖这一轮：工具结果回来之后最后一条不是用户消息，说明这一轮她已经看过时间了。
 */
function stampMoment(messages: readonly AgentMessage[], note: string): AgentMessage[] {
	const last = messages.at(-1);
	if (last === undefined || last.role !== "user") return [...messages];
	const content = last.content;
	if (typeof content === "string") return [...messages.slice(0, -1), { ...last, content: content + note }];
	if (!Array.isArray(content)) return [...messages];
	return [...messages.slice(0, -1), { ...last, content: [...content, { type: "text", text: note }] }];
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
	private readonly expressions: boolean | undefined;
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
	private lookRoots: readonly string[];
	/** 能写的地方（ADR-0034）。跟能看的分开记，放开一个不等于放开另一个。 */
	private writeRoots: readonly string[];

	private shellRoots: readonly string[];
	private readonly dmNames: readonly string[];
	/** 感知层：每轮现问一次「他现在在干什么」（ADR-0037）。 */
	private readonly perception: (() => string | null) | undefined;
	private readonly mood: (() => string | null) | undefined;
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
	/** 这一轮的 `<脸红>` 过滤器：边收边吐，标记不进字幕（ADR-0041）。 */
	private expressionStream: ExpressionStream | null = null;
	/** 已经告诉过壳子的那张脸，同一个不重复发。 */
	private announcedExpression: string | null = null;
	private turns = 0;
	/** 这一轮还剩几条请求要强制带工具（0 = 不强制）。 */
	private forcedToolChoices = 0;
	/** 这一轮真的调过几次工具，用来判断她是不是又在嘴上说「搜过了」。 */
	private toolCallsThisTurn = 0;
	/** system prompt 里那一行日期是按哪天写的；跨天就重刷，免得她拿昨天的日子当今天。 */
	private promptDay = "";
	/** 她上一轮说的话。用来认「要不我查一下？」这种自己答应的事。 */
	private lastReply: string | null = null;
	/** 自动档位（ADR-0031）：关掉时这一轮永远走 `reasoningEffort`。 */
	private readonly autoEffort: boolean;
	private readonly effortOptions: EffortOptions;
	/** 这一轮实际用的档位；streamFn 每次请求都从这里读。 */
	private currentEffort: IrisEffort | null = null;
	/** 这一轮的档位是怎么定的（给日志和 REPL 看）。 */
	private effortJudgement: EffortJudgement | null = null;
	/** 上一轮对方说的话 / 调了几次工具 / 工具报错几次 / 活干完没有。信封就靠这几样。 */
	private lastInput = "";
	private lastToolCalls = 0;
	private lastUnfinished = false;
	/** 这一轮工具报错过几次（收尾时折进 lastToolErrors）。 */
	private toolErrorsThisTurn = 0;

	constructor(options: IrisSessionOptions) {
		this.persona = options.persona;
		this.personaDoc = options.personaDoc;
		this.stageDirections = options.stageDirections;
		this.punctuation = options.punctuation;
		this.expressions = options.expressions;
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
		this.autoEffort = options.autoEffort === true;
		this.effortOptions = options.effort ?? {};
		this.state = options.state ?? DEFAULT_STATE;
		this.bond = options.relationship ?? defaultRelationship(this.clock());

		// buildPrompt() 在 new Agent(...) 的参数里就会被调用，所以这些字段必须先定好。
		// 构造发生在 buildPrompt() 之前：prompt 里写「你能上网 / 你能看文件」要使真手上有的工具。
		this.toolNames = new Set((options.tools ?? []).map((tool) => tool.name));
		this.lookRoots = options.lookRoots ?? [];
		this.writeRoots = options.writeRoots ?? [];
		this.shellRoots = options.shellRoots ?? options.writeRoots ?? [];
		this.dmNames = options.dmNames ?? [];
		this.perception = options.perception;
		this.mood = options.mood;
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
			streamFn:
				options.streamFn ??
				magpieStreamFn({
					...options,
					forceToolCall: () => this.takeForcedToolCall(),
					effort: () => this.currentEffort ?? options.reasoningEffort ?? DEFAULT_SESSION_EFFORT,
				}),
			// 每次请求前：把强制查那句提示从历史里摘掉，再按预算压缩（ADR-0023 / ADR-0025）。
			transformContext: (messages: readonly AgentMessage[]) => this.prepareHistory(messages),
		});
		this.agent.subscribe((event) => this.forward(event));
	}

	get model(): string {
		return this.agent.state.model.id;
	}

	/** 这一轮的档位是怎么定的；自动档位关着就是 null（ADR-0031）。 */
	get effort(): EffortJudgement | null {
		return this.effortJudgement;
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

	/**
	 * 换掉「她手边能看哪几个文件夹」。他刚放开一个新地方时要调一次，
	 * 否则 prompt 里还写着「只有家目录」，她会照旧说没权限（ADR-0033 补记）。
	 */
	setLookRoots(roots: readonly string[]): void {
		this.lookRoots = [...roots];
		this.refreshPrompt();
	}

	/** 同上，换掉「她能写哪几个文件夹」。他新放开一个写的地方时调一次。 */
	setWriteRoots(roots: readonly string[]): void {
		this.writeRoots = [...roots];
		this.shellRoots = [...roots];
		this.refreshPrompt();
	}

	/** 同上，只换「她能跑命令哪几个文件夹」；一般不用单独调，跟着写的那本账走。 */
	setShellRoots(roots: readonly string[]): void {
		this.shellRoots = [...roots];
		this.refreshPrompt();
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
		return await this.runTurn(input, hooks, false);
	}

	/**
	 * 她自己开口（ADR-0037）：没人跟她说话，但她想说了。
	 *
	 * 为什么不走 `agent.continue()`：pi 在「最后一条是 assistant」时直接抛
	 * `Cannot continue from message role: assistant`（实测 0 ms），所以主动说话
	 * 只能伪造一条 user 消息。这条 cue 留在 transcript 里（刻意的：下次她看见自己
	 * 说过的话，得知道当时是因为什么说的），但不进原文归档——那不是对方说的话。
	 * 她那句回复本身照常归档，只是没有配对的问题（ADR-0037 补记）。
	 */
	async speakUp(hint = "", hooks: IrisSessionHooks = {}): Promise<IrisTurn> {
		const tail =
			hint.trim() === ""
				? "他没在跟你说话。你刚瞥了一眼他屏幕上在做什么，看到值得说的就自己说一句；没什么好说的就别出声。"
				: hint.trim();
		return await this.runTurn(SELF_START + tail + "）", hooks, true);
	}

	private async runTurn(input: string, hooks: IrisSessionHooks, internal: boolean): Promise<IrisTurn> {
		if (this.agent.state.isStreaming) await this.agent.waitForIdle();
		// 跨夜了就把日期那一行换掉，否则第二天她还拿着昨天的 prompt 说今天（实测把周二说成周四）。
		if (this.promptDay !== dayStamp(this.clock())) this.refreshPrompt();

		const startedAt = performance.now();
		this.runStartedAt = startedAt;
		this.firstTokenMs = 0;
		this.expressionStream = new ExpressionStream();
		this.announcedExpression = null;
		this.hook = hooks.onEvent ?? null;
		// 她要出去查，就把第一条请求的工具强制出来（ADR-0025）。只有一条：查出结果后照常说话。
		this.toolCallsThisTurn = 0;
		this.toolErrorsThisTurn = 0;
		// 只有联网工具时强制一次工具调用；只给了文件工具时不逼她——那会变成被迫 ls 一遍。
		const hasSearch = this.toolNames.has("web_search");
		// 上一轮她说「要不我查一下」，这一轮对方「嗯」——不强制她就直接答「查了」。
		const promised = hasSearch && looksLikePromiseAgreement(this.lastReply, input);
		const lookup = hasSearch && (promised || looksLikeLookup(input));
		// 问私信同理：她要是不调工具，就会照着上一段聊天编一句「他说：你在吗」。
		const wantsDm = this.toolNames.has("douyin_im") && looksLikeDm(input) && lookup === false;
		const forcedTools = lookup || wantsDm;
		this.forcedToolChoices = forcedTools ? 1 : 0;
		// 这一轮想多深（ADR-0031）。要在 agent.prompt 之前定好：streamFn 每次请求都读它。
		// 自动档位关着就恒走 reasoningEffort，跟她一路的行为一致。
		if (this.autoEffort) {
			const judged = await this.decideEffort(input, forcedTools);
			this.effortJudgement = judged;
			this.currentEffort = judged.effort;
		} else {
			this.effortJudgement = null;
			this.currentEffort = null;
		}
		// 强制出来的工具调用由模型决定搜什么。历史里挂着一句没答完的话时，它会照着旧题目搜，
		// 所以这里把「这一句是新问题」说清楚——只影响本轮发给模型的输入，归档的仍是原话。
		const promptInput = wantsDm
			? input + dmNudge()
			: promised
				? input + promiseNudge()
				: lookup
					? input + lookupNudge()
					: input;
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
		// 整段再摘一次：模型没走增量（或一次吐完）时，流式过滤器压根没看到这些字。
		const spoken = splitExpression(text);
		text = spoken.text;
		const expression = spoken.expression ?? this.announcedExpression;
		this.announceExpression(expression);
		if (this.punctuation !== "prose") {
			text = chatify(stripTrailingPeriods(text));
		}

		const usage: IrisUsage = { promptTokens: message.usage.input, completionTokens: message.usage.output };
		if (message.usage.reasoning !== undefined) usage.reasoningTokens = message.usage.reasoning;

		const at = this.clock();
		const turn: IrisTurn = {
			text,
			expression,
			reasoning,
			model: message.responseModel ?? message.model,
			usage,
			firstTokenMs: Math.round(this.firstTokenMs),
			latencyMs: Math.round(performance.now() - startedAt),
			stopReason: message.stopReason,
			effort:
				this.currentEffort ?? (forcedTools ? "none" : (this.effortOptions.defaultEffort ?? DEFAULT_SESSION_EFFORT)),
			episode: null,
		};

		this.bond = {
			...this.bond,
			sharedMoments: this.bond.sharedMoments + 1,
			lastInteractionAt: at,
		};

		if (this.memory !== null && !internal) {
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

		// 主动开口也落归档，只是不写 cue（ADR-0037 补记）：她这一句不记账，他接下来
		// 那句照写，重启接回历史就成了「他在回答一句不存在的话」。
		this.archiveTurn(internal ? null : input, text, at);
		this.lastReply = text;
		// 下一轮的「信封」：上一句说了什么、调了几次工具、活干完没有。
		this.lastInput = input;
		this.lastToolCalls = this.toolCallsThisTurn;
		this.lastUnfinished = this.toolErrorsThisTurn > 0 || message.stopReason !== "stop";
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

	/**
	 * 原文落库：不脱敏的事交给 archive，这里只负责把这一轮原样交过去。
	 *
	 * `input` 为 null 表示这一轮没有对方的话（她自己开口）——只写她那句，
	 * 不写 cue：cue 是给模型看的现场，不是对方说过的内容（ADR-0037 补记）。
	 */
	private archiveTurn(input: string | null, reply: string, at: number): void {
		if (this.archive === null || this.conversationId === null) return;
		const turns: RawTurn[] =
			input === null
				? [{ role: "assistant", content: reply, at }]
				: [
						{ role: "user", content: input, at },
						{ role: "assistant", content: reply, at },
					];
		this.archive.appendTurns(this.conversationId, turns);
	}

	/**
	 * 定这一轮的档位（ADR-0031）。
	 *
	 * 信封里的东西全部来自上一轮的事实，不塞指令——分类靠事实，写指令等于自己判。
	 * 强制工具那一条请求必须落到 none：网关在思考模式下对 `tool_choice: "required"` 直接 400，
	 * 所以「要她真去查」和「让她多想」在同一轮里不能并存，查优先。
	 */
	private async decideEffort(input: string, forcedTools: boolean): Promise<EffortJudgement> {
		const envelope: EffortEnvelope = {
			...(this.effortJudgement === null ? {} : { previousEffort: this.effortJudgement.effort }),
			...(this.lastInput.length === 0 ? {} : { userText: this.lastInput }),
			...(this.lastReply === null ? {} : { assistantTail: this.lastReply }),
			toolCalls: this.lastToolCalls,
			unfinished: this.lastUnfinished,
		};
		const judged = await chooseEffort(input, envelope, this.effortOptions);
		if (forcedTools && judged.effort !== "none") {
			return { ...judged, effort: "none", reason: `${judged.reason}；这一轮要逼工具，思考得关` };
		}
		return judged;
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
			const previous = restored.at(-1);
			// 她主动开口那句在库里排在自己上一句回复后面（中间没有对方的话），
			// 接回时并成一条 assistant——连着的两条有些网关不认。
			if (row.role === "assistant" && previous !== undefined && previous.role === "assistant") {
				previous.content.push({ type: "text", text: `\n${row.content}` });
				continue;
			}
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

	/** 手上有私信那两件（ADR-0029）。 */
	private hasDmTools(): boolean {
		return this.toolNames.has("douyin_im") || this.toolNames.has("douyin_dm");
	}

	/** 手上有只读文件三件里的任何一件（ADR-0026）。 */
	private hasFileTools(): boolean {
		return this.toolNames.has("ls") || this.toolNames.has("read") || this.toolNames.has("grep");
	}

	/** 手上有写工具（ADR-0034）；只给 request_write 也算，她会开口要。 */
	private hasWriteTools(): boolean {
		return (
			this.toolNames.has("write_file") ||
			this.toolNames.has("append_file") ||
			this.toolNames.has("make_dir") ||
			this.toolNames.has("move_path") ||
			this.toolNames.has("request_write")
		);
	}

	private buildPrompt(): string {
		const now = this.clock();
		this.promptDay = dayStamp(now);
		const remembered = this.remembered(now);
		const selfFacts = this.selfFactLines();
		const style = this.styleText();
		return buildSystemPrompt({
			persona: this.persona,
			...(this.personaDoc === undefined ? {} : { portrait: this.personaDoc }),
			...(this.stageDirections === undefined ? {} : { stageDirections: this.stageDirections }),
			...(this.punctuation === undefined ? {} : { punctuation: this.punctuation }),
			...(this.expressions === undefined ? {} : { expressions: this.expressions }),
			state: this.state,
			relationship: this.bond,
			recent: this.memory?.recent(this.recentLimit) ?? [],
			...(remembered.length === 0 ? {} : { memories: remembered }),
			...(selfFacts.length === 0 ? {} : { selfFacts }),
			...(style === undefined ? {} : { style }),
			...(this.toolNames.has("web_search") ? { canSearch: true } : {}),
			...(this.hasFileTools() ? { canLook: true } : {}),
			...(this.toolNames.has("douyin_feed") ? { canWatch: true } : {}),
			...(this.hasDmTools() ? { canDm: true, dmNames: this.dmNames } : {}),
			...(this.hasFileTools() && this.lookRoots.length > 0 ? { lookRoots: this.lookRoots } : {}),
			...(this.hasWriteTools() ? { canWrite: true } : {}),
			...(this.hasWriteTools() && this.writeRoots.length > 0 ? { writeRoots: this.writeRoots } : {}),
			...(this.toolNames.has("look_at_screen") ? { canSee: true } : {}),
			...(this.toolNames.has("look_at_screen") && this.perception !== undefined ? { perception: true } : {}),
			...(this.mood === undefined ? {} : { mood: true }),
			...(this.toolNames.has("run_command") ? { canShell: true } : {}),
			...(this.toolNames.has("run_command") && this.shellRoots.length > 0 ? { shellRoots: this.shellRoots } : {}),
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
	 * pi 每次请求前都会叫这里：
	 * ① 摘掉强制查留下的那句提示（它只是这一次的脚注，留在历史里她会当成对方一直在说）；
	 * ② 超预算就压；
	 * ③ 把**这一刻**的时间盖在今天这条用户消息后面——system prompt 里的时间是建 prompt 那一刻的，
	 * 开着过夜就成了昨天的日期（用户实测就是这么拿到「周四」的）。历史消息不带时间戳，
	 * 所以每轮变化的部分只在末尾，prefix cache 不受影响。
	 */
	private async prepareHistory(messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
		// 最后一条是本轮刚发出去的：那句脚注得让它看见，否则等于没加。
		const last = messages.length - 1;
		const cleaned = messages.map((message, index) => (index === last ? message : stripNudge(message)));
		const compacted = this.compactor === null ? cleaned : await this.compactor.compact(cleaned);
		return stampMoment(compacted, momentNote(this.clock()) + this.perceptionNote() + this.moodNote());
	}

	/** 她这一刻的心情（ADR-0044）；平了就什么都不加，免得每轮都在报「我很平静」。 */
	private moodNote(): string {
		if (this.mood === undefined) return "";
		try {
			const line = this.mood();
			if (line === null || line.trim().length === 0) return "";
			return "\n（你现在的心情：" + line.trim() + "）";
		} catch {
			return "";
		}
	}

	/** 感知层那一行；没接、或者还没看到过就什么都不加。 */
	private perceptionNote(): string {
		if (this.perception === undefined) return "";
		try {
			const line = this.perception();
			if (line === null || line.trim().length === 0) return "";
			return "\n（" + line.trim() + "）";
		} catch {
			return "";
		}
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

	/** 她换了一张脸就告诉壳子一声；同一张不重复发。 */
	private announceExpression(id: string | null): void {
		if (id === null || id === this.announcedExpression) return;
		this.announcedExpression = id;
		this.emit({ type: "expression", id });
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
					// 标记当场摘掉再播：字幕里不该出现 `<脸红>`，但脸要立刻换（ADR-0041）。
					const text = this.expressionStream === null ? inner.delta : this.expressionStream.push(inner.delta);
					this.announceExpression(this.expressionStream?.expression ?? null);
					if (text !== "") this.emit({ type: "delta", text });
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
				if (event.isError) this.toolErrorsThisTurn += 1;
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
