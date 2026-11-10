/**
 * 这一轮该想多深：`none` 还是 `low`。
 *
 * 思路照 `justhalfbit/dsh-plugin-jev-effort-selector`（DSH 社区插件，Jev System One 分类模型
 * 判断每条消息值多少思考量）：一封小信封 → 分类 → 一条硬规则（延续没干完的活就不降档）→
 * 低置信向上取 → 任何失败都静默沿用原档。改动两处：
 *
 * 1. 插件每轮都问一次分类模型（Jev 约 1–2 秒）。她说话本来就 1–2 秒，再垫一次分类会把每个
 *    「在吗」都拖到两秒半，所以这里**先走规则**，规则拿不准才考虑问模型（默认关，见
 *    `allowClassifier`）。实测本机 `deepseek-flash` 一次分类 1.0–1.2 秒（.artifacts/effort-probe.ts）。
 * 2. 插件给的是敲代码用的档位（off/low/medium/high/xhigh/max）；她的梯子只有 none/low/high
 *    三档，而且默认永远不该是 high——实测 high 只是把 95 字的回答写到 177 字，人味反而更淡。
 */

import { completeText } from "./complete.ts";
import type { ModelReasoningEffort } from "./model.ts";

export type IrisEffort = ModelReasoningEffort;

/** 三档从弱到强。 */
export const EFFORT_RANK: readonly IrisEffort[] = ["none", "low", "high"];

export function rankOf(effort: IrisEffort): number {
	return EFFORT_RANK.indexOf(effort);
}

function stronger(a: IrisEffort, b: IrisEffort): IrisEffort {
	return rankOf(a) >= rankOf(b) ? a : b;
}

/** 上一轮留下的迹（只放事实，不放指令）。 */
export interface EffortEnvelope {
	/** 上一轮实际用的档位。 */
	previousEffort?: IrisEffort;
	/** 上一轮用户说的话（截断到 200 字）。 */
	userText?: string;
	/** 上一轮她怎么收尾的（截断到 200 字）。 */
	assistantTail?: string;
	/** 上一轮调了几次工具。 */
	toolCalls?: number;
	/** 上一轮的活没干完（工具报错、被打断、超长）。 */
	unfinished?: boolean;
}

export interface EffortDecision {
	effort: IrisEffort;
	relation: "continues" | "new";
	confidence: number;
}

export interface EffortJudgement extends EffortDecision {
	/** 这个决定来自哪：规则、分类模型、还是兜底。 */
	source: "rule" | "classifier" | "fallback";
	/** 给日志看的一句话。 */
	reason: string;
	/** 花了多少毫秒。 */
	ms: number;
}

/** 测试缝：把「这句 + 信封 → 判断」固定住；生产用 `classifyEffort()`。 */
export type EffortClassifier = (text: string, envelope: EffortEnvelope) => Promise<EffortDecision | null>;

export interface EffortOptions {
	/** 允许问分类模型。默认 false——规则拿不准时宁可保持默认档。 */
	allowClassifier?: boolean;
	/** 分类模型；不给就用本机网关 `deepseek-flash`。 */
	classifier?: EffortClassifier;
	/** 分类的超时；超了就沿用规则/默认。默认 1500 ms。 */
	classifierTimeoutMs?: number;
	/** 低于这个置信度就取更强的档。默认 0.6（同插件）。 */
	threshold?: number;
	/** 兜底档。默认 `none`。 */
	defaultEffort?: IrisEffort;
}

/** 「继续」「然后呢」「嗯」「好」这类只说了一半的话。 */
const CONTINUE_ONLY =
	/^\s*(?:继续|接着|然后呢?|往下|go\s*on|continue|嗯+|好+|行|对|是|查吧|ok|okay)(?:[，,、~～\s]*(?:继续|接着|嗯+|好+|查吧|ok))*[。.!！?？~～\s]*$/iu;
/** 命中就值得多想一会儿的说法（不是「查一下」——那是工具，不是思考）。 */
const HARD_MARKERS =
	/核对|确认一下|对不对|对不对得上|站不住|站得住|比较|对比|分析|为什么|凭什么|原因|证明|矛盾|冲突|漏洞|算一下|算算|推一下|权衡|取舍|哪个更|哪个好|依据|证据|逻辑|推理|数一下|统计|关系是|是不是一致|有没有错|错在哪/u;
/** 纯招呼 / 纯应答。 */
const TRIVIAL =
	/^\s*(?:在吗|在不在|嗨|hi|hello|早|晚安|谢谢|多谢|哈哈+|笑死|好可爱|知道了|收到|嗯嗯)[。.!！?？~～\s]*$/iu;
/** 长材料：一次贴进来一大段，多半是要她读懂再表态。 */
const LONG_TEXT = 160;

function clip(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

export interface RuleDecision extends EffortDecision {
	reason: string;
}

/**
 * 规则版判断。拿不准就返回 null（交给调用方决定要不要问模型，或者保持默认档）。
 *
 * 顺序有意义：先认「只说了一半的话」——这类必须继承上一轮的深度，否则「继续」会被当成
 * 打招呼丢掉上下文；再看硬词；再看长度；最后才是纯招呼。
 */
export function ruleEffort(text: string, envelope: EffortEnvelope = {}): RuleDecision | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;

	if (CONTINUE_ONLY.test(trimmed)) {
		const previous = envelope.previousEffort ?? "none";
		return {
			effort: previous,
			relation: "continues",
			confidence: 0.9,
			reason: envelope.unfinished === true ? "接着说没干完的活" : "接着上一句",
		};
	}

	if (HARD_MARKERS.test(trimmed)) {
		return {
			effort: "low",
			relation: "new",
			confidence: 0.75,
			reason: "要核对或讲道理",
		};
	}

	if (trimmed.length >= LONG_TEXT) {
		return {
			effort: "low",
			relation: "new",
			confidence: 0.7,
			reason: "一次给了长材料",
		};
	}

	if (TRIVIAL.test(trimmed) || trimmed.length <= 8) {
		return {
			effort: "none",
			relation: "new",
			confidence: TRIVIAL.test(trimmed) ? 0.8 : 0.65,
			reason: "一句招呼、应答或随口的短话",
		};
	}

	return null;
}

function envelopeText(envelope: EffortEnvelope): string {
	const lines = ["Context: an ongoing conversation, in Chinese, with a companion character."];
	if (envelope.previousEffort) lines.push(`- reasoning effort used: ${envelope.previousEffort}`);
	if (envelope.userText) lines.push(`- user said: ${JSON.stringify(clip(envelope.userText, 200))}`);
	if (envelope.assistantTail) {
		lines.push(`- assistant ended with: ${JSON.stringify(clip(envelope.assistantTail, 200))}`);
	}
	if (envelope.toolCalls !== undefined) lines.push(`- tool calls last turn: ${envelope.toolCalls}`);
	if (envelope.unfinished !== undefined) {
		lines.push(`- previous turn finished: ${envelope.unfinished ? "no" : "yes"}`);
	}
	return lines.join("\n");
}

const CLASSIFIER_CRITERIA: Record<string, string> = {
	none: "greetings, acknowledgments, banter, emotional reactions, one-line opinions, simple facts",
	low: "comparing or verifying numbers, spotting a contradiction, judging whether an argument holds, weighing tradeoffs, planning several steps",
	high: "long multi-step reasoning that must be right the first time",
};

/**
 * 把分类模型的回话读成判断。模型爱把 JSON 包在围栏里、爱在前面写一句「好的」，
 * 所以只取第一个 `{` 到最后一个 `}`；读不出来就当它没答，不猜。
 */
export function parseEffortReply(raw: string): EffortDecision | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const effort = record.effort;
	if (effort !== "none" && effort !== "low" && effort !== "high") return null;
	const relation = record.relation === "continues" ? "continues" : "new";
	const confidence = typeof record.confidence === "number" ? record.confidence : 0;
	return { effort, relation, confidence };
}

/**
 * 走本机网关的分类模型（同插件的 Jev 位置，但用 `deepseek-flash` + JSON 输出）。
 *
 * 一次 1.0–1.2 秒，够不上实时车道——只在规则拿不准、且调用方显式打开时用。
 */
export function classifyEffort(options: { model?: string; timeoutMs?: number } = {}): EffortClassifier {
	return async (text, envelope) => {
		const prompt = [
			"How much reasoning does answering the CURRENT user message require?",
			'Reply with JSON only: {"effort":"none"|"low"|"high","relation":"continues"|"new","confidence":0.0-1.0}',
			"Criteria:",
			...EFFORT_RANK.map((id) => `- ${id}: ${CLASSIFIER_CRITERIA[id]}`),
			"relation: continues = follows up on, confirms, or answers the previous turn; new = unrelated.",
			"",
			"CURRENT user message:",
			clip(text, 500),
		].join("\n");
		const raw = await completeText(prompt, {
			system: envelopeText(envelope),
			temperature: 0,
			maxTokens: 120,
			timeoutMs: options.timeoutMs ?? 8_000,
			...(options.model === undefined ? {} : { model: options.model }),
		});
		return parseEffortReply(raw);
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

/**
 * 定这一轮的档位。
 *
 * 插件那条硬规则原样搬来：**在接着干一件没干完的活时，不低于上一轮**；其余听判断的。
 * 低置信度取更强的档（多想几个 token 便宜，少想一次就是答错）。
 */
export async function chooseEffort(
	text: string,
	envelope: EffortEnvelope = {},
	options: EffortOptions = {},
): Promise<EffortJudgement> {
	const started = Date.now();
	const threshold = options.threshold ?? 0.6;
	const fallback = options.defaultEffort ?? "none";
	let decision: EffortDecision | null = null;
	let source: EffortJudgement["source"] = "fallback";
	let reason = "没意见，保持原档";

	const ruled = ruleEffort(text, envelope);
	if (ruled !== null) {
		decision = ruled;
		source = "rule";
		reason = ruled.reason;
	} else if (options.allowClassifier === true) {
		const classifier = options.classifier ?? classifyEffort();
		const asked = await withTimeout(classifier(text, envelope), options.classifierTimeoutMs ?? 1_500);
		if (asked !== null) {
			decision = asked;
			source = "classifier";
			reason = "分类模型判断";
			if (asked.confidence < threshold) {
				const lifted = stronger(asked.effort, envelope.previousEffort ?? asked.effort);
				if (lifted !== asked.effort) {
					decision = { ...asked, effort: lifted };
					reason = "置信度低，往上取一档";
				}
			}
		}
	}

	let effort = decision?.effort ?? fallback;
	const relation = decision?.relation ?? "new";
	// 硬规则：接着干没干完的活，不降档。
	if (relation === "continues" && envelope.unfinished === true && envelope.previousEffort) {
		const anchored = stronger(effort, envelope.previousEffort);
		if (anchored !== effort) {
			effort = anchored;
			reason = `${reason}；活没干完，不降档`;
		}
	}

	return {
		effort,
		relation,
		confidence: decision?.confidence ?? 0,
		source,
		reason,
		ms: Date.now() - started,
	};
}
