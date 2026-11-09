/**
 * 联网：把本机 modsearch 的搜索/抓页能力包成 pi 的工具（ADR-0024）。
 *
 * 为什么不自己写抓取：pi 上游没有 websearch 工具（它的 tools 只有 bash/edit/find/grep/ls/read/write），
 * 联网在 pi 生态里靠 skill 或 MCP。本机现成的是 @liustack/modsearch —— 一个纯 Node 的搜索桥，
 * 默认走 Firecrawl 免注册通道（每月 1,000 免费 credits，不用 key、不用注册），失败自动换
 * Keenable / You.com。CLI 输出固定是 JSON 信封，所以这里只做三件事：
 * 1. 起子进程跑 CLI，把 JSON 收回来；
 * 2. 摊平成 IRIS 自己的结构（引擎、耗时、不确定性都留着，别丢证据）；
 * 3. 给模型看的时候压成短文本 —— 她要说人话，不是把搜索结果念一遍。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** 一次搜索/抓页最多等多久。modsearch 自己也会按 --deadline 收工。 */
export const DEFAULT_WEB_TIMEOUT_MS = 45_000;
/** 喂回模型的搜索结果最多多少字。 */
export const DEFAULT_SEARCH_CHARS = 2_400;
/** 抓回来的正文最多多少字。 */
export const DEFAULT_PAGE_CHARS = 3_600;
/** 搜索默认取几条。 */
export const DEFAULT_MAX_RESULTS = 5;

export type WebStatus = "ok" | "degraded" | "unavailable";
export type WebSource = "web" | "x";

export interface WebSearchItem {
	title: string;
	url: string;
	snippet: string;
	source?: string;
	publishedAt?: string;
}

export interface WebSearchResult {
	query: string;
	summary: string;
	items: readonly WebSearchItem[];
	uncertainty: readonly string[];
	warnings: readonly string[];
	engine: string | null;
	source: string;
	status: WebStatus;
	durationMs: number;
}

export interface WebLink {
	title: string;
	url: string;
}

export interface WebPage {
	url: string;
	title: string;
	content: string;
	links: readonly WebLink[];
	uncertainty: readonly string[];
	warnings: readonly string[];
	engine: string | null;
	status: WebStatus;
	durationMs: number;
}

export type WebErrorKind = "missing" | "timeout" | "exit" | "parse";

export class WebError extends Error {
	readonly kind: WebErrorKind;
	readonly detail: string;

	constructor(kind: WebErrorKind, message: string, detail = "") {
		super(message);
		this.name = "WebError";
		this.kind = kind;
		this.detail = detail;
	}
}

export interface ModsearchRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** 起一次子进程并收 JSON；测试里换掉它就不用真联网。 */
export type ModsearchRunner = (
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<ModsearchRun>;

export interface WebOptions {
	/** modsearch 的入口 js；不填就自己找包里的 dist/main.js。 */
	bin?: string;
	/** 用哪个 node 跑它，默认当前进程。 */
	nodePath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runner?: ModsearchRunner;
}

export interface WebSearchOptions extends WebOptions {
	maxResults?: number;
	/** web（默认）或 x；x 需要本机装了 Grok，没有就退化成网页结果。 */
	source?: WebSource;
}

export interface WebFetchOptions extends WebOptions {
	/** 抓这一页时重点看什么，可省。 */
	focus?: string;
}

/** 找到 modsearch 的可执行入口：显式参数 > 环境变量 > 已安装的包。 */
export function modsearchEntry(options: { bin?: string } = {}): string {
	const explicit = options.bin ?? process.env.MODSEARCH_BIN ?? "";
	if (explicit.length > 0) {
		if (!existsSync(explicit)) {
			throw new WebError("missing", `找不到 modsearch：${explicit}`);
		}
		return explicit;
	}
	try {
		const require = createRequire(import.meta.url);
		const manifest = require.resolve("@liustack/modsearch/package.json");
		const entry = join(dirname(manifest), "dist", "main.js");
		if (existsSync(entry)) return entry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WebError("missing", "没装 @liustack/modsearch，联网用不了", message);
	}
	throw new WebError("missing", "装上了 @liustack/modsearch，但里面没有 dist/main.js");
}

function spawnModsearch(
	entry: string,
	nodePath: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ModsearchRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodePath, [entry, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			reject(new WebError("exit", `起不了 modsearch：${error.message}`));
		});
		child.on("close", (code: number | null) => finish(code));
		signal?.addEventListener(
			"abort",
			() => {
				child.kill("SIGKILL");
				finish(null);
			},
			{ once: true },
		);
	});
}

/** 从 CLI 的 stdout 里挖出那个 JSON 信封（前面若有杂音就跳过）。 */
export function parseEnvelope(raw: string): Record<string, unknown> {
	const text = raw.trim();
	const start = text.indexOf("{");
	if (start < 0) throw new WebError("parse", "modsearch 没有输出 JSON", text.slice(0, 400));
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WebError("parse", `modsearch 输出的 JSON 解析不了：${message}`, text.slice(0, 400));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new WebError("parse", "modsearch 输出的不是对象", text.slice(0, 400));
	}
	return parsed as Record<string, unknown>;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function entryOf(envelope: Record<string, unknown>): Record<string, unknown> {
	const results = envelope.results;
	if (!Array.isArray(results) || results.length === 0) {
		throw new WebError("parse", "modsearch 没有返回 results", JSON.stringify(envelope).slice(0, 400));
	}
	const rows = results.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
	const usable = rows.find((row) => row.status !== "unavailable");
	const picked = usable ?? rows[0];
	if (picked === undefined) throw new WebError("parse", "modsearch 的 results 是空的");
	return picked;
}

function statusOf(value: unknown): WebStatus {
	return value === "degraded" || value === "unavailable" ? value : "ok";
}

async function runCli(args: string[], options: WebOptions): Promise<Record<string, unknown>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
	const entry = modsearchEntry(options);
	const nodePath = options.nodePath ?? process.execPath;
	const runner: ModsearchRunner =
		options.runner ?? ((cliArgs, call) => spawnModsearch(entry, nodePath, cliArgs, call.timeoutMs, call.signal));
	const run = await runner([...args, "--deadline", String(timeoutMs)], {
		timeoutMs: timeoutMs + 5_000,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (run.timedOut) throw new WebError("timeout", `联网超过 ${timeoutMs} ms 没回来`, run.stderr.slice(-400));
	if (run.code !== 0) {
		const detail = (run.stderr.trim() || run.stdout.trim()).slice(-600);
		throw new WebError("exit", `modsearch 退出码 ${run.code ?? "未知"}`, detail);
	}
	return parseEnvelope(run.stdout);
}

/** 搜网页（或 X）。拿不到就抛 WebError，别把异常咽掉。 */
export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult> {
	const trimmed = query.trim();
	if (trimmed.length === 0) throw new WebError("parse", "搜索词是空的");
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const args = ["-q", trimmed, "--max-results", String(maxResults)];
	if (options.source === "x") args.push("--source", "x");
	const envelope = await runCli(args, options);
	const entry = entryOf(envelope);
	const rawItems = Array.isArray(entry.items) ? entry.items : [];
	const items: WebSearchItem[] = [];
	for (const raw of rawItems) {
		if (typeof raw !== "object" || raw === null) continue;
		const row = raw as Record<string, unknown>;
		const url = textOf(row.url);
		if (url.length === 0) continue;
		const item: WebSearchItem = { title: textOf(row.title) || url, url, snippet: textOf(row.snippet) };
		const source = textOf(row.source);
		if (source.length > 0) item.source = source;
		const published = textOf(row.published_at);
		if (published.length > 0) item.publishedAt = published;
		items.push(item);
	}
	return {
		query: trimmed,
		summary: textOf(entry.summary),
		items,
		uncertainty: strings(entry.uncertainty),
		warnings: strings(entry.warnings),
		engine: textOf(entry.engine) || null,
		source: textOf(entry.source) || "web",
		status: statusOf(entry.status),
		durationMs: Math.round(Number(entry.durationSeconds ?? 0) * 1000),
	};
}

/** 抓一页正文。 */
export async function fetchPage(url: string, options: WebFetchOptions = {}): Promise<WebPage> {
	const trimmed = url.trim();
	if (trimmed.length === 0) throw new WebError("parse", "网址是空的");
	const args = ["-u", trimmed];
	if (options.focus !== undefined && options.focus.trim().length > 0) args.push("-q", options.focus.trim());
	const envelope = await runCli(args, options);
	const entry = entryOf(envelope);
	const content = textOf(entry.content);
	if (content.length === 0) {
		throw new WebError("exit", `这一页没抓到正文：${trimmed}`, strings(entry.warnings).join(" / "));
	}
	const rawLinks = Array.isArray(entry.links) ? entry.links : [];
	const links: WebLink[] = [];
	for (const raw of rawLinks) {
		if (typeof raw !== "object" || raw === null) continue;
		const row = raw as Record<string, unknown>;
		const href = textOf(row.url);
		if (href.length === 0) continue;
		links.push({ title: textOf(row.title) || href, url: href });
	}
	return {
		url: textOf(envelope.url) || trimmed,
		title: textOf(entry.title),
		content,
		links,
		uncertainty: strings(entry.uncertainty),
		warnings: strings(entry.warnings),
		engine: textOf(entry.engine) || null,
		status: statusOf(entry.status),
		durationMs: Math.round(Number(entry.durationSeconds ?? 0) * 1000),
	};
}

/** firecrawl 的 summary 是机械拼的（"Firecrawl returned 4 ranked result(s)"），别当结论用。 */
function usefulSummary(summary: string): string {
	const flat = summary.trim();
	if (flat.length === 0) return "";
	if (/^Firecrawl returned/i.test(flat)) return "";
	return flat;
}

function cut(value: string, limit: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 搜索结果压成给模型看的短文本：标题、网址、一小截摘要，够她去说人话。 */
export function renderSearch(result: WebSearchResult, maxChars = DEFAULT_SEARCH_CHARS): string {
	const lines: string[] = [];
	const summary = usefulSummary(result.summary);
	const meta = [result.engine ?? "未知引擎", result.source, `${result.durationMs} ms`].join(" · ");
	lines.push(`搜索结果（${meta}）`);
	if (summary.length > 0) lines.push(summary);
	let used = lines.join("\n").length;
	let listed = 0;
	for (const [index, item] of result.items.entries()) {
		const head = `${index + 1}. ${cut(item.title, 80)}`;
		const body = [`   ${item.url}`];
		if (item.snippet.length > 0) body.push(`   ${cut(item.snippet, 180)}`);
		if (item.publishedAt !== undefined) body.push(`   发布：${item.publishedAt}`);
		const block = [head, ...body].join("\n");
		if (used + block.length > maxChars) break;
		lines.push(block);
		used += block.length + 1;
		listed += 1;
	}
	const rest = result.items.length - listed;
	if (rest > 0) lines.push(`（还有 ${rest} 条没列）`);
	for (const warning of result.warnings) lines.push(`注意：${cut(warning, 160)}`);
	for (const doubt of result.uncertainty) lines.push(`不确定：${cut(doubt, 160)}`);
	if (listed === 0 && rest === 0) lines.push("（什么都没搜到）");
	return lines.join("\n");
}

/** 抓回来的正文压成短文本。 */
export function renderPage(page: WebPage, maxChars = DEFAULT_PAGE_CHARS): string {
	const head = [page.title.length > 0 ? page.title : page.url, page.url];
	const lines = [head.join("\n")];
	lines.push(cut(page.content, maxChars));
	if (page.content.length > maxChars) lines.push("（这一页太长，后面截掉了）");
	for (const warning of page.warnings) lines.push(`注意：${cut(warning, 160)}`);
	for (const doubt of page.uncertainty) lines.push(`不确定：${cut(doubt, 160)}`);
	return lines.join("\n\n");
}

export interface WebToolDetails {
	ok: boolean;
	mode: "search" | "fetch";
	engine?: string | null;
	status?: WebStatus;
	durationMs?: number;
	url?: string;
	items?: readonly WebSearchItem[];
	error?: string;
	kind?: WebErrorKind;
}

export interface WebToolOptions extends WebOptions {
	/** 一条搜索结果喂回模型的上限字数。 */
	maxChars?: number;
	/** 抓页正文喂回模型的上限字数。 */
	maxPageChars?: number;
}

function failure(error: unknown, mode: "search" | "fetch"): AgentToolResult<WebToolDetails> {
	if (error instanceof WebError) {
		const detail = error.detail.length > 0 ? `（${cut(error.detail, 200)}）` : "";
		return {
			content: [{ type: "text", text: `联网失败：${error.message}${detail}` }],
			details: { ok: false, mode, error: error.message, kind: error.kind },
			isError: true,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `联网失败：${message}` }],
		details: { ok: false, mode, error: message },
		isError: true,
	};
}

/** 给 pi 用的联网工具：web_search 与 web_fetch，名字跟 dsh 那边一致。 */
export function webTools(options: WebToolOptions = {}): AgentTool[] {
	const search: AgentTool = {
		name: "web_search",
		label: "联网搜索",
		description:
			"搜网页，拿回标题、网址和摘要。问今天的事、新闻、价格、版本号、别人说的梗的出处，或者你确实不知道又值得查的东西时用它。一次一条，三五条结果就够，别为了同一个话题连着搜好几遍。",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "搜索词，用具体的人名、产品名、时间，别写整句问题" },
				max_results: { type: "integer", minimum: 1, maximum: 10, description: "要几条，默认 5，别再往上加" },
				source: { type: "string", enum: ["web", "x"], description: "一般不用传；只有问 X 上的人怎么反应时才传 x" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WebToolDetails>> => {
			const args = params as { query?: unknown; max_results?: unknown; source?: unknown };
			const query = typeof args.query === "string" ? args.query : "";
			const maxResults = typeof args.max_results === "number" ? args.max_results : undefined;
			const source = args.source === "x" ? "x" : "web";
			try {
				const result = await searchWeb(query, {
					...options,
					...(maxResults === undefined ? {} : { maxResults }),
					source,
				});
				const body = renderSearch(result, options.maxChars ?? DEFAULT_SEARCH_CHARS);
				return {
					content: [{ type: "text", text: body }],
					details: {
						ok: true,
						mode: "search",
						engine: result.engine,
						status: result.status,
						durationMs: result.durationMs,
						items: result.items,
					},
				};
			} catch (error) {
				return failure(error, "search");
			}
		},
	};

	const fetch: AgentTool = {
		name: "web_fetch",
		label: "看一个网页",
		description: "打开一个网址，拿回正文。搜索结果里的链接值得细看时用它。",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "要打开的网址，带 http(s)://" },
				focus: { type: "string", description: "只想看里面哪一部分，可省" },
			},
			required: ["url"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WebToolDetails>> => {
			const args = params as { url?: unknown; focus?: unknown };
			const url = typeof args.url === "string" ? args.url : "";
			const focus = typeof args.focus === "string" ? args.focus : undefined;
			try {
				const page = await fetchPage(url, {
					...options,
					...(focus === undefined ? {} : { focus }),
				});
				return {
					content: [{ type: "text", text: renderPage(page, options.maxPageChars ?? DEFAULT_PAGE_CHARS) }],
					details: {
						ok: true,
						mode: "fetch",
						engine: page.engine,
						status: page.status,
						durationMs: page.durationMs,
						url: page.url,
					},
				};
			} catch (error) {
				return failure(error, "fetch");
			}
		},
	};

	return [search, fetch];
}
