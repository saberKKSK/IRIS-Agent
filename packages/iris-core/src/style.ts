/**
 * 语料库 → 风格档案（ADR-0017）。
 *
 * 把导出的聊天记录 / 小说片段 / 文案读进来，量出「这个人怎么说话」，渲染成 system prompt
 * 里的一小段，会话照着说。三条边界：
 * 1. 只写能数出来的东西（句长、标点、语气词、口癖、自称），不靠几个形容词编人格；
 * 2. 原话样本只学语感，不许照抄、也不许在回复里提起；
 * 3. 「别这样说话」取自 lieflat-less-ai-tone（CC BY-NC 4.0，shiujan）的实测规则，
 *    只留对短对话成立的几条 —— 每条都是 AI 明显多于真人的写法。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { CompleteFn } from "./complete.ts";
import { completeText } from "./complete.ts";

export interface CorpusFile {
	name: string;
	text: string;
}

export interface StyleSample {
	/** 说话人；没有前缀就是空串。 */
	speaker: string;
	text: string;
}

export interface UtteranceOptions {
	/** 只学这个说话人（聊天记录里挑一个人）。 */
	speaker?: string;
	minChars?: number;
	maxChars?: number;
	limit?: number;
}

export interface CountedToken {
	token: string;
	count: number;
}

export type PunctuationKey =
	| "comma"
	| "period"
	| "question"
	| "exclaim"
	| "ellipsis"
	| "dash"
	| "semicolon"
	| "enumeration"
	| "wave";

export interface StyleProfile {
	name: string;
	source: string;
	speaker: string;
	utterances: number;
	chars: number;
	avgChars: number;
	medianChars: number;
	p90Chars: number;
	/** 句长离散度：越大越忽长忽短。 */
	lengthCv: number;
	punctuationPer1000: Record<PunctuationKey, number>;
	questionShare: number;
	exclaimShare: number;
	emojiPerMessage: number;
	particles: readonly CountedToken[];
	catchphrases: readonly CountedToken[];
	selfRefs: readonly string[];
	addresses: readonly string[];
	samples: readonly string[];
	/** 模型归纳的人格（可选，拿不到就没有）。 */
	summary?: string;
	importedAt: number;
}

export type ToneKind = "flip" | "colon" | "opener" | "enumeration" | "dash" | "semicolon" | "translation";

export interface ToneFlag {
	kind: ToneKind;
	label: string;
	hit: string;
	advice: string;
}

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".jsonl", ".json", ".log", ".csv"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", ".cache", ".next", "target"]);

/** 这些写法 AI 明显多于真人；渲染进 prompt 当「别这样」。 */
export const TONE_ADVICE: readonly string[] = [
	"不要「不是 A，而是 B」这种翻案句",
	"不要「核心是：」「说白了」这类提示语",
	"不要三个顿号堆一串并列",
	"不要每句都解释上一句",
];

const TONE_RULES: readonly { kind: ToneKind; label: string; pattern: RegExp; advice: string }[] = [
	{
		kind: "flip",
		label: "翻案句",
		pattern:
			/(?:不是|并非|不再)[^。！？\n]{1,24}(?:而是|其实是)|看似[^。！？\n]{1,20}实则|与其说[^。！？\n]{1,20}不如说/,
		advice: "把「不是 A，而是 B」拆成两句，或者只说 B",
	},
	{
		kind: "colon",
		label: "结论冒号",
		pattern: /(?:核心是|关键是|重点是|一句话总结|原因如下|总结一下)[：:]/,
		advice: "结论直接说，不要先起一个标题",
	},
	{
		kind: "opener",
		label: "起手式",
		pattern: /(?:说白了|说穿了|先说结论|不得不说|简单来说)[，,：:]?/,
		advice: "删掉「说白了」这种垫话，直接开口",
	},
	{
		kind: "enumeration",
		label: "三连顿号",
		pattern: /[^。！？\n，,]{1,20}、[^。！？\n，,]{1,20}、/,
		advice: "并列超过两项就拆开说，或只留最要紧的那个",
	},
	{ kind: "dash", label: "破折号", pattern: /——|—{1,2}/, advice: "破折号换成逗号或句号" },
	{ kind: "semicolon", label: "分号", pattern: /[；;]/, advice: "分号换成句号，断成两句" },
	{
		kind: "translation",
		label: "翻译腔",
		pattern: /对于[^。！？\n]{1,12}来说|在[^。！？\n]{1,12}方面|就[^。！？\n]{1,12}而言|当[^。！？\n]{1,20}时[，,]/,
		advice: "把「对于…来说」改成「你」「我」直接说",
	},
];

const PUNCTUATION: readonly { key: PunctuationKey; pattern: RegExp }[] = [
	{ key: "comma", pattern: /[，,]/g },
	{ key: "period", pattern: /[。．.]/g },
	{ key: "question", pattern: /[？?]/g },
	{ key: "exclaim", pattern: /[！!]/g },
	{ key: "ellipsis", pattern: /…+|\.{3,}/g },
	{ key: "dash", pattern: /——|—/g },
	{ key: "semicolon", pattern: /[；;]/g },
	{ key: "enumeration", pattern: /、/g },
	{ key: "wave", pattern: /[～~]/g },
];

const PARTICLES: readonly string[] = [
	"啊",
	"呀",
	"吧",
	"呢",
	"嘛",
	"哦",
	"喔",
	"诶",
	"欸",
	"嘿",
	"哈",
	"啦",
	"嘞",
	"咯",
	"嗯",
	"唉",
	"哎",
];
const SELF_REFS: readonly string[] = ["我", "俺", "咱", "本人", "人家", "自己", "朕", "老娘", "本小姐"];
const ADDRESSES: readonly string[] = [
	"你",
	"您",
	"你们",
	"大家",
	"宝",
	"宝贝",
	"亲爱的",
	"哥哥",
	"姐姐",
	"老师",
	"兄弟",
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

const SPEAKER_LINE = /^([\u4e00-\u9fa5A-Za-z0-9_·.]{1,16})\s*[：:]\s*(.+)$/;
const SKIP_LINE = /^(#{1,6}\s|>\s|\x60|\||[-*+]\s|\d+[.)]\s)/;
const HAS_WORD = /[\u4e00-\u9fa5A-Za-z]/;
const HAN_RUN = /[\u4e00-\u9fa5]{2,}/g;

/** 读语料：目录递归（最多 3 层）、只收文本类扩展名、单文件封顶 2 MB。 */
export function readCorpus(
	paths: readonly string[],
	options: { maxFiles?: number; maxBytes?: number; depth?: number } = {},
): CorpusFile[] {
	const maxFiles = options.maxFiles ?? 200;
	const maxBytes = options.maxBytes ?? 2_000_000;
	const depth = options.depth ?? 3;
	const files: CorpusFile[] = [];

	const visit = (path: string, level: number): void => {
		if (files.length >= maxFiles) return;
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(path);
		} catch {
			return;
		}
		if (info.isDirectory()) {
			if (level > depth) return;
			let names: string[];
			try {
				names = readdirSync(path);
			} catch {
				return;
			}
			for (const name of names.sort()) {
				if (name.startsWith(".") || SKIP_DIR.has(name)) continue;
				visit(join(path, name), level + 1);
			}
			return;
		}
		if (!info.isFile() || info.size === 0 || info.size > maxBytes) return;
		const ext = extname(path).toLowerCase();
		if (!TEXT_EXT.has(ext)) return;
		let text: string;
		try {
			text = decode(readFileSync(path));
		} catch {
			return;
		}
		if (ext === ".json" || ext === ".jsonl") {
			const lines = structuredLines(text);
			if (lines.length === 0) return;
			files.push({ name: basename(path), text: lines.join("\n") });
			return;
		}
		files.push({ name: basename(path), text });
	};

	for (const path of paths) visit(path, 0);
	return files;
}

function decode(buffer: Buffer): string {
	const text = buffer.toString("utf8");
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/** 把聊天导出（JSON / JSONL）压成「说话人：内容」的文本，后面统一走行解析。 */
export function structuredLines(text: string): string[] {
	const rows: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		const content = pickString(record, ["text", "content", "message", "msg", "body"]);
		if (content === undefined) return;
		const speaker = pickString(record, ["speaker", "name", "role", "from", "nickname", "sender"]);
		rows.push(speaker === undefined ? content : speaker + "：" + content);
	};
	const trimmed = text.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) for (const item of parsed) push(item);
		} catch {
			// 不是合法 JSON 就当空
		}
		return rows;
	}
	if (trimmed.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = undefined;
		}
		if (parsed !== undefined) {
			const record = parsed as Record<string, unknown>;
			const list = Array.isArray(record.messages)
				? record.messages
				: Array.isArray(record.data)
					? record.data
					: undefined;
			if (list !== undefined) {
				for (const item of list) push(item);
				return rows;
			}
			push(parsed);
			return rows;
		}
		// 整段不是单个 JSON 对象：落到下面按 JSONL 逐行解析
	}
	for (const line of trimmed.split(/\r?\n/)) {
		const raw = line.trim();
		if (raw.length === 0) continue;
		try {
			push(JSON.parse(raw) as unknown);
		} catch {
			// 不是 JSON 行
		}
	}
	return rows;
}

/** 逐行切句，剥掉「名字：」前缀与包裹的引号；纯标点、标题、列表行都不算说话。 */
export function splitUtterances(file: CorpusFile, options: UtteranceOptions = {}): StyleSample[] {
	const minChars = options.minChars ?? 2;
	const maxChars = options.maxChars ?? 240;
	const wanted = options.speaker;
	const rows: StyleSample[] = [];
	for (const raw of file.text.split(/\r?\n/)) {
		let line = raw.trim();
		if (line.length === 0 || SKIP_LINE.test(line)) continue;
		let speaker = "";
		const match = SPEAKER_LINE.exec(line);
		if (match !== null && match[1] !== undefined && match[2] !== undefined) {
			speaker = match[1];
			line = match[2];
		}
		line = line
			.replace(/^[「『"'（(【\s]+/, "")
			.replace(/[」』"'）)】\s]+$/, "")
			.replace(/\*\*|__|\x60/g, "")
			.trim();
		if (wanted !== undefined && speaker !== wanted) continue;
		const length = [...line].length;
		if (length < minChars || length > maxChars || !HAS_WORD.test(line)) continue;
		rows.push({ speaker, text: line });
		if (options.limit !== undefined && rows.length >= options.limit) break;
	}
	return rows;
}

/** 语料里出现过哪些说话人，按句数排序（挑「模仿谁」用）。 */
export function speakersOf(files: readonly CorpusFile[]): readonly CountedToken[] {
	const counts = new Map<string, number>();
	for (const file of files) {
		for (const sample of splitUtterances(file)) {
			if (sample.speaker.length === 0) continue;
			counts.set(sample.speaker, (counts.get(sample.speaker) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([token, count]) => ({ token, count }))
		.sort((left, right) => right.count - left.count);
}

export interface StyleMeta {
	name: string;
	source: string;
	speaker?: string;
	summary?: string;
	now?: number;
}

/** 量出风格档案：全部是计数，不给形容词。 */
export function analyzeStyle(samples: readonly StyleSample[], meta: StyleMeta): StyleProfile {
	const texts = samples.map((sample) => sample.text);
	const lengths = texts.map((text) => [...text].length);
	const chars = lengths.reduce((total, length) => total + length, 0);
	const sorted = [...lengths].sort((left, right) => left - right);
	const mean = lengths.length === 0 ? 0 : chars / lengths.length;
	const variance =
		lengths.length === 0 ? 0 : lengths.reduce((total, length) => total + (length - mean) ** 2, 0) / lengths.length;

	const punctuationPer1000 = {} as Record<PunctuationKey, number>;
	for (const rule of PUNCTUATION) {
		const hits = texts.reduce((total, text) => total + (text.match(rule.pattern)?.length ?? 0), 0);
		punctuationPer1000[rule.key] = round(chars === 0 ? 0 : (hits / chars) * 1000, 1);
	}

	const questionShare = ratio(texts.filter((text) => /[？?]/.test(text)).length, texts.length);
	const exclaimShare = ratio(texts.filter((text) => /[！!]/.test(text)).length, texts.length);
	const emojiCount = texts.reduce((total, text) => total + (text.match(EMOJI)?.length ?? 0), 0);

	const particles = PARTICLES.map((token) => ({
		token,
		count: texts.reduce((total, text) => total + countOf(text, token), 0),
	}))
		.filter((row) => row.count > 0)
		.sort((left, right) => right.count - left.count);

	return {
		name: meta.name,
		source: meta.source,
		speaker: meta.speaker ?? "",
		utterances: texts.length,
		chars,
		avgChars: round(mean, 1),
		medianChars: round(quantile(sorted, 0.5), 1),
		p90Chars: round(quantile(sorted, 0.9), 1),
		lengthCv: round(mean === 0 ? 0 : Math.sqrt(variance) / mean, 2),
		punctuationPer1000,
		questionShare: round(questionShare, 2),
		exclaimShare: round(exclaimShare, 2),
		emojiPerMessage: round(ratio(emojiCount, texts.length), 2),
		particles,
		catchphrases: catchphrasesOf(texts),
		selfRefs: presentWords(texts, SELF_REFS, 3),
		addresses: presentWords(texts, ADDRESSES, 3),
		samples: pickSamples(texts, 4),
		summary: meta.summary,
		importedAt: meta.now ?? Date.now(),
	};
}

/** 渲染成 prompt 的一段；没有样本时返回空串，调用方据此跳过。 */
export function renderStyle(profile: StyleProfile, options: { maxSamples?: number } = {}): string {
	if (profile.utterances === 0) return "";
	const samples = profile.samples.slice(0, options.maxSamples ?? 4);
	const per1000 = profile.punctuationPer1000;
	const lines: string[] = [];
	lines.push("## 说话方式（照着语料学" + (profile.speaker.length > 0 ? "：" + profile.speaker : "") + "）");
	lines.push(
		"- 长度：平均 " +
			profile.avgChars +
			" 字一句，中位 " +
			profile.medianChars +
			" 字，九成不超过 " +
			profile.p90Chars +
			" 字。",
	);
	const marks: string[] = [
		"逗号 " + per1000.comma,
		"句号 " + per1000.period,
		"问号 " + per1000.question,
		"感叹号 " + per1000.exclaim,
		"省略号 " + per1000.ellipsis,
		"破折号 " + per1000.dash,
	];
	if (per1000.semicolon < 1) marks.push("几乎不用分号");
	lines.push("- 标点（每千字）：" + marks.join("、") + "。");
	lines.push(
		"- 语气：带问号的句子占 " +
			percent(profile.questionShare) +
			"，带感叹号的占 " +
			percent(profile.exclaimShare) +
			"，每条消息 " +
			profile.emojiPerMessage +
			" 个表情。",
	);
	if (profile.particles.length > 0) {
		lines.push(
			"- 语气词：" +
				profile.particles
					.slice(0, 6)
					.map((row) => row.token + " " + row.count)
					.join("、"),
		);
	}
	if (profile.catchphrases.length > 0) {
		lines.push(
			"- 口癖：" +
				profile.catchphrases
					.slice(0, 5)
					.map((row) => "「" + row.token + "」")
					.join(""),
		);
	}
	const refs = profile.selfRefs.length > 0 ? "自称 " + profile.selfRefs.join("、") : "";
	const address = profile.addresses.length > 0 ? "叫对方 " + profile.addresses.join("、") : "";
	if (refs.length > 0 || address.length > 0) {
		lines.push("- " + [refs, address].filter((part) => part.length > 0).join("；") + "。");
	}
	if (profile.summary !== undefined && profile.summary.trim().length > 0) {
		lines.push("- 这个人：" + profile.summary.trim());
	}
	if (samples.length > 0) {
		lines.push("- 原话（只学语感，不要照抄，也不要在回复里提起这些句子）：");
		for (const sample of samples) lines.push("  · 「" + sample + "」");
	}
	lines.push("- 别这样说话：" + TONE_ADVICE.join("；") + "。");
	return lines.join("\n");
}

/** 逮 AI 味：每条都是「AI 明显多于真人」的写法，命中就给改法。 */
export function toneFlags(text: string): readonly ToneFlag[] {
	const flags: ToneFlag[] = [];
	for (const rule of TONE_RULES) {
		const match = rule.pattern.exec(text);
		if (match === null) continue;
		flags.push({ kind: rule.kind, label: rule.label, hit: match[0], advice: rule.advice });
	}
	return flags;
}

const SUMMARY_SYSTEM = "你是一个语言风格分析器。只描述样本里看得出来的说话方式，不编造，不恭维。";

export interface SummarizeOptions {
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	maxTokens?: number;
	/** 测试缝：直接给「prompt → 文本」。 */
	complete?: CompleteFn;
	onError?: (error: unknown) => void;
}

/** 用模型把样本归纳成 2-3 句人格描述；失败返回 undefined，档案照旧可用。 */
export async function summarizeStyle(
	profile: StyleProfile,
	options: SummarizeOptions = {},
): Promise<string | undefined> {
	const samples = profile.samples.slice(0, 12);
	if (samples.length === 0) return undefined;
	const prompt = [
		"下面是同一个人的原话。用 2-3 句话概括他/她说话的方式和性格：口吻、情绪、对对方的态度。",
		"要求：只写样本里能看出来的；不要堆形容词；不要用「不是……而是……」的句式；不超过 120 字。",
		"",
		samples.map((text) => "- " + text).join("\n"),
	].join("\n");
	const complete: CompleteFn =
		options.complete ??
		((body, call) =>
			completeText(body, {
				model: options.model,
				baseUrl: options.baseUrl,
				apiKey: options.apiKey,
				timeoutMs: options.timeoutMs ?? 30_000,
				maxTokens: options.maxTokens ?? 300,
				system: call.system,
			}));
	try {
		const raw = await complete(prompt, { system: SUMMARY_SYSTEM });
		const text = raw.replace(/\s+/g, " ").trim();
		if (text.length === 0) return undefined;
		return text.length > 200 ? text.slice(0, 199) + "…" : text;
	} catch (error) {
		options.onError?.(error);
		return undefined;
	}
}

export interface ImportStyleOptions extends SummarizeOptions, UtteranceOptions {
	/** 语料来源描述，默认取前几个文件名。 */
	source?: string;
	/** 让模型再归纳一句人格（多一次 3-5 秒的调用）。 */
	summarize?: boolean;
	now?: number;
}

/** 导入入口：读语料 → 挑句 → 量档案 →（可选）模型归纳人格。 */
export async function importStyle(
	name: string,
	files: readonly CorpusFile[],
	options: ImportStyleOptions = {},
): Promise<StyleProfile> {
	const samples: StyleSample[] = [];
	for (const file of files) samples.push(...splitUtterances(file, options));
	if (samples.length === 0) {
		throw new Error("语料里没有能用的句子：需要至少一句 2 个字以上的中文或英文（标题、列表、代码行会被跳过）");
	}
	const profile = analyzeStyle(samples, {
		name,
		source:
			options.source ??
			files
				.map((file) => file.name)
				.slice(0, 3)
				.join("、"),
		speaker: options.speaker ?? "",
		now: options.now,
	});
	if (options.summarize === true) {
		const summary = await summarizeStyle(profile, options);
		if (summary !== undefined) profile.summary = summary;
	}
	return profile;
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function ratio(part: number, whole: number): number {
	return whole === 0 ? 0 : part / whole;
}

function percent(value: number): string {
	return Math.round(value * 100) + "%";
}

function quantile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
	return sorted[index] ?? 0;
}

function countOf(text: string, token: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const index = text.indexOf(token, from);
		if (index < 0) break;
		count += 1;
		from = index + token.length;
	}
	return count;
}

function presentWords(texts: readonly string[], words: readonly string[], limit: number): readonly string[] {
	const joined = texts.join("\n");
	return words
		.map((word) => ({ word, count: countOf(joined, word) }))
		.filter((row) => row.count > 0)
		.sort((left, right) => right.count - left.count)
		.slice(0, limit)
		.map((row) => row.word);
}

/** 口癖：2-4 字片段里反复出现的那些；先留长的，含在长片段里的短片段丢掉。 */
function catchphrasesOf(texts: readonly string[], limit = 6): readonly CountedToken[] {
	const counts = new Map<string, number>();
	const bump = (token: string): void => {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	};
	for (const text of texts) {
		for (const run of text.match(HAN_RUN) ?? []) {
			if (run.length <= 8) bump(run);
			for (let size = 2; size <= 4; size += 1) {
				for (let index = 0; index + size <= run.length; index += 1) bump(run.slice(index, index + size));
			}
		}
	}
	const floor = Math.max(3, Math.round(texts.length * 0.03));
	const ranked = [...counts.entries()]
		.filter(([token, count]) => count >= floor && token.length >= 2)
		.sort((left, right) => right[1] - left[1] || right[0].length - left[0].length);
	const picked: CountedToken[] = [];
	for (const [token, count] of ranked) {
		if (picked.some((row) => row.token.includes(token) || token.includes(row.token))) continue;
		picked.push({ token, count });
		if (picked.length >= limit) break;
	}
	return picked;
}

function pickSamples(texts: readonly string[], limit: number): readonly string[] {
	const unique = [...new Set(texts)];
	const pool = unique.filter((text) => {
		const length = [...text].length;
		return length >= 4 && length <= 80;
	});
	const source = pool.length === 0 ? unique : pool;
	if (source.length <= limit) return source;
	const picked: string[] = [];
	const step = source.length / limit;
	for (let index = 0; index < limit; index += 1) {
		const value = source[Math.floor(index * step)];
		if (value !== undefined) picked.push(value);
	}
	return picked;
}
