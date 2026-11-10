/**
 * 她会刷抖音（ADR-0027）：推荐流 → 看评论 → 自己发一条。
 *
 * 为什么借 dsh-douyin-scroll 的 MCP 入口，而不是自己写：抖音的评论接口要 a_bogus 签名
 * （jsdom + 七个 sdk 文件）和水印 Cookie，这套东西那个插件已经调通了；重写等于重造签名器，
 * 而签名器一坏就整条链废。它的 tools/mcp-server.mjs 是标准 stdio MCP（零依赖、只吐 JSON-RPC），
 * 正好能当一个子进程用 —— 不复制业务逻辑，行为跟插件里那份一模一样。
 *
 * 四条边界：
 *   ① 只读两件（推荐流、评论）随便用。
 *   ② 点赞、评论都由她自己决定发不发（ADR-0028：不设人工确认闸门）；真的要拦就传 confirmReply / confirmLike。
 *   ③ 一次一轮、最多一条。刷是「看几条」，不是「翻十条」。
 *   ④ 说什么由她自己的系统提示决定（人格在那份 prompt 里），这里只管通路。
 *
 * 点赞走的是另一条路：写接口要 ticket-guard 的请求头，只有页面里的 SDK 算得出来，
 * 所以交给 browser.ts 在插件那台无头 Chrome 的页面上下文里发（见 ADR-0028）。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { evaluateOnDouyin } from "./browser.ts";

/** 插件家目录（Cookie、venv、forward-pick.json 都在里面）。 */
export function defaultDouyinHome(): string {
	const fromEnv = process.env.DOUYIN_HOME?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return join(homedir(), ".dsh", "douyin-duty");
}

/** 插件的 MCP 入口。装了插件就在 profile 的 node_modules 里。 */
export function defaultDouyinServer(): string {
	const fromEnv = process.env.IRIS_DOUYIN_SERVER?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	const dshHome = process.env.DSH_HOME?.trim();
	const base = dshHome !== undefined && dshHome !== "" ? dshHome : join(homedir(), ".dsh");
	return join(base, "profiles", "desktop", "node_modules", "dsh-douyin-scroll", "tools", "mcp-server.mjs");
}

export interface DouyinOptions {
	/** 插件家目录，默认 ~/.dsh/douyin-duty。 */
	home?: string;
	/** mcp-server.mjs 的路径，默认 profile 的 node_modules 里那份。 */
	serverPath?: string;
	/** 用哪个 node 跑，默认当前进程（同一个 Node 就一定跑得起来）。 */
	nodePath?: string;
}

export interface DouyinCallOptions extends DouyinOptions {
	/** 一次调用最多等多久，默认 5 分钟（取推荐流会慢）。 */
	timeoutMs?: number;
}

export interface DouyinResult {
	ok: boolean;
	/** 服务器回的那段 JSON（能解析时）。 */
	data?: Record<string, unknown>;
	/** 解析不出来的原文。 */
	text?: string;
	error?: string;
	stderr?: string;
}

interface Rpc {
	jsonrpc?: string;
	id?: number;
	result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
	error?: { code?: number; message?: string };
}

/** 一句话说清服务器回的 content 里是什么。 */
function unwrap(reply: Rpc): DouyinResult {
	const text = reply.result?.content?.find((item) => item.type === "text")?.text ?? "";
	if (text === "") return { ok: false, error: "服务器没有回内容" };
	try {
		const data = JSON.parse(text) as Record<string, unknown>;
		return { ok: data.ok !== false, data };
	} catch {
		return { ok: reply.result?.isError !== true, text };
	}
}

/**
 * 调一次插件工具：起 MCP 子进程 → initialize → tools/call → 收工。
 * 每次一个进程（起一个 Node 约 100 ms，真正慢的是后面的 Python 那一跳），不留后台状态。
 */
export async function douyinCall(
	tool: string,
	args: Record<string, unknown> = {},
	options: DouyinCallOptions = {},
): Promise<DouyinResult> {
	const server = options.serverPath ?? defaultDouyinServer();
	const node = options.nodePath ?? process.execPath;
	const home = options.home ?? defaultDouyinHome();
	const timeoutMs = options.timeoutMs ?? 300_000;

	return await new Promise<DouyinResult>((resolve) => {
		const child = spawn(node, [server], {
			env: { ...process.env, DOUYIN_HOME: home, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: DouyinResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
			resolve(tail === "" ? result : { ...result, stderr: tail });
		};

		const timer = setTimeout(() => {
			finish({ ok: false, error: "等了 " + String(Math.round(timeoutMs / 1000)) + " 秒还没回来" });
		}, timeoutMs);

		child.on("error", (error) => {
			finish({ ok: false, error: "起不来：" + error.message });
		});
		// 进程提前退出（比如 mcp-server.mjs 路径写错了）就别干等到超时
		child.on("close", (code) => {
			finish({ ok: false, error: "服务器提前退出（exit " + String(code) + "）" });
		});

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += String(chunk);
			let index = stdout.indexOf("\n");
			while (index >= 0) {
				const line = stdout.slice(0, index).trim();
				stdout = stdout.slice(index + 1);
				index = stdout.indexOf("\n");
				if (line === "") continue;
				if (line.startsWith("{") === false) continue;
				let reply: Rpc;
				try {
					reply = JSON.parse(line) as Rpc;
				} catch {
					continue;
				}
				if (reply.id === 1) {
					child.stdin.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							method: "tools/call",
							params: { name: tool, arguments: args },
						}) + "\n",
					);
					continue;
				}
				if (reply.id === 2) {
					if (reply.error !== undefined) {
						finish({ ok: false, error: reply.error.message ?? "服务器报错" });
						return;
					}
					finish(unwrap(reply));
					return;
				}
			}
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
		});
		child.stdin.write(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "iris-core", version: "1" },
				},
			}) + "\n",
		);
	}).catch((error: unknown) => ({ ok: false, error: String(error) }));
}

export interface DouyinConsentRequest {
	awemeId: string;
	text: string;
	/** 要回复的那条评论 cid（发顶层评论时没有）。 */
	commentId?: string;
}

export interface DouyinToolOptions extends DouyinOptions {
	/**
	 * 发评论前问人的钩子；**默认没有 = 直接发**（ADR-0028）。
	 * 想守一道闸就传它，返回 false 就只出草稿。
	 */
	confirmReply?: (request: DouyinConsentRequest) => Promise<boolean> | boolean;
	/** 点赞前问人的钩子；默认没有 = 直接点。 */
	confirmLike?: (request: { awemeId: string; like: boolean }) => Promise<boolean> | boolean;
	/** 私信名单；不给就读 ~/.iris/contacts.json（ADR-0029）。空名单 = 谁都不读不回。 */
	contacts?: readonly DouyinContact[];
	/** 发私信前问人的钩子；默认没有 = 直接发。 */
	confirmDm?: (request: { name: string; text: string }) => Promise<boolean> | boolean;
	/** 在页面里跑表达式（测试缝，生产用不到）。 */
	evaluatePage?: (expression: string) => Promise<unknown>;
	/** 一轮取几条，默认 6。 */
	feedSize?: number;
	/** 单次调用超时，默认 5 分钟。 */
	timeoutMs?: number;
}

export interface DouyinToolDetails {
	ok: boolean;
	action: "feed" | "comments" | "like" | "reply" | "im" | "dm";
	awemeId?: string;
	needsConfirm?: boolean;
	sent?: boolean;
	/** 点完爱心之后这条是不是已赞。 */
	digged?: boolean;
	error?: string;
}

function details(action: DouyinToolDetails["action"], patch: Partial<DouyinToolDetails> = {}): DouyinToolDetails {
	return { ok: false, action, ...patch };
}

function said(text: string, value: DouyinToolDetails, isError = false): AgentToolResult<DouyinToolDetails> {
	return { content: [{ type: "text", text }], details: value, ...(isError ? { isError: true } : {}) };
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把推荐流清单摊成几行，够她判断要不要看评论。 */
export function renderFeed(data: Record<string, unknown>, limit = 8): string {
	const list = Array.isArray(data.list) ? data.list : [];
	if (list.length === 0) return "（这一轮什么也没取到）";
	const lines: string[] = ["这一轮 " + String(list.length) + " 条："];
	for (const [index, raw] of list.slice(0, limit).entries()) {
		const row = (raw ?? {}) as Record<string, unknown>;
		const desc = textOf(row.desc).replace(/\s+/gu, " ").slice(0, 90);
		const author = textOf(row.author);
		const digg = numberOf(row.digg);
		const comment = numberOf(row.comment);
		const age = numberOf(row.age_h);
		const parts = [String(index + 1) + ". " + (desc === "" ? "（没有文案）" : desc)];
		const meta: string[] = [];
		if (author !== "") meta.push("@" + author);
		if (digg !== undefined) meta.push("赞" + String(digg));
		if (comment !== undefined) meta.push("评" + String(comment));
		if (age !== undefined) meta.push(String(Math.round(age)) + " 小时前");
		if (meta.length > 0) parts.push("（" + meta.join(" · ") + "）");
		const id = textOf(row.aweme_id);
		// 分享链接带一长串签名参数（四五百字），只留能被认出来的短形式
		parts.push("\n   id=" + id + (id === "" ? "" : " · https://www.douyin.com/video/" + id));
		lines.push(parts.join(""));
	}
	return lines.join("\n");
}

/** 评论摊平；带楼中楼的行保持原样，只是压掉多余空白。 */
export function renderComments(data: Record<string, unknown>, limit = 40): string {
	const list = Array.isArray(data.comments) ? data.comments : [];
	if (list.length === 0) return "（评论区是空的，或者没取到）";
	const lines = list.slice(0, limit).map((raw) => textOf(raw).replace(/\s+/gu, " ").trim());
	const head = "共 " + String(numberOf(data.count) ?? list.length) + " 条（这里列 " + String(lines.length) + " 条）：";
	return [head, ...lines].join("\n");
}

/** 发出去之后回什么。 */
export function renderReply(data: Record<string, unknown>): string {
	const cid = textOf(data.cid) || textOf(data.comment_id);
	const placement = (data.placement ?? {}) as Record<string, unknown>;
	const warns: string[] = [];
	if (placement.ok === false) warns.push(textOf(placement.warn) || "位置可能不对");
	if (data.ok === false) return "没发出去：" + (textOf(data.error) || textOf(data.hint) || "原因不明");
	return "发出去了" + (cid === "" ? "" : "（cid=" + cid + "）") + (warns.length === 0 ? "" : "；" + warns.join("；"));
}

/** 点赞/取消点赞的结果。 */
export interface DouyinLikeResult {
	ok: boolean;
	/** 调用之后这条是不是已赞（从 aweme/detail 的 user_digged 读，不是接口自报）。 */
	digged: boolean;
	/** 这条的文案前几十字，用来确认点对了。 */
	desc?: string;
	digg?: number;
	error?: string;
}

export interface DouyinLikeOptions extends DouyinOptions {
	/** true 点赞（默认），false 取消。 */
	like?: boolean;
	/** 在页面里跑表达式；测试时换掉。 */
	evaluate?: (expression: string) => Promise<unknown>;
}

/** 页面里发请求要带的公共参数（跟签名器里那套一致，写接口也吃这套）。 */
const PAGE_COMMON: Record<string, string> = {
	device_platform: "webapp",
	aid: "6383",
	channel: "channel_pc_web",
	pc_client_type: "1",
	version_code: "190500",
	version_name: "19.5.0",
	cookie_enabled: "true",
	screen_width: "1920",
	screen_height: "1080",
	browser_language: "zh-CN",
	browser_platform: "Win32",
	browser_name: "Chrome",
	browser_version: "141.0.0.0",
	engine_name: "Blink",
	engine_version: "141.0.0.0",
	os_name: "Windows",
	os_version: "10",
	platform: "PC",
};

/** 在抖音页面里点爱心，然后把这条的 user_digged 读回来（接口自报的 is_digg 是调用前的状态）。 */
export function diggExpression(awemeId: string, like: boolean): string {
	return [
		"(async () => {",
		"  const qs = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))).join('&');",
		"  const common = " + JSON.stringify(PAGE_COMMON) + ";",
		"  const id = " + JSON.stringify(awemeId) + ";",
		"  const on = " + (like ? "true" : "false") + ";",
		"  const body = 'aweme_id=' + encodeURIComponent(id) + '&type=' + (on ? '1' : '0');",
		"  const posted = await fetch('/aweme/v1/web/commit/item/digg/?' + qs(Object.assign({}, common, { aweme_id: id, type: on ? '1' : '0' })), {",
		"    method: 'POST', credentials: 'include',",
		"    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body,",
		"  }).then((r) => r.json()).catch(() => ({}));",
		"  const got = await fetch('/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, common, { aweme_id: id })), { credentials: 'include' })",
		"    .then((r) => r.json()).catch(() => ({}));",
		"  const item = got.aweme_detail || {};",
		"  return {",
		"    status: posted.status_code,",
		"    message: String(posted.status_msg || ''),",
		"    digged: item.user_digged,",
		"    digg: item.digg_count,",
		"    desc: String(item.desc || '').slice(0, 80),",
		"  };",
		"})()",
	].join("\n");
}

/**
 * 点赞（或取消）。写接口要 ticket-guard 的请求头，只有在页面上下文里发才带得出来，
 * 所以走插件那台无头 Chrome —— 屏幕上什么都不会出现。
 */
export async function likeVideo(awemeId: string, options: DouyinLikeOptions = {}): Promise<DouyinLikeResult> {
	const like = options.like !== false;
	const run =
		options.evaluate ??
		((expression: string) =>
			evaluateOnDouyin<Record<string, unknown>>(
				expression,
				options.home === undefined ? {} : { home: options.home },
			));
	let raw: unknown;
	try {
		raw = await run(diggExpression(awemeId, like));
	} catch (error) {
		return { ok: false, digged: false, error: String(error instanceof Error ? error.message : error) };
	}
	const data = (raw ?? {}) as Record<string, unknown>;
	const status = numberOf(data.status);
	const digged = numberOf(data.digged) === 1;
	const desc = textOf(data.desc);
	const digg = numberOf(data.digg);
	const base = { digged, ...(desc === "" ? {} : { desc }), ...(digg === undefined ? {} : { digg }) };
	if (status !== 0) {
		return { ok: false, ...base, error: textOf(data.message) || "接口没认" };
	}
	if (like !== digged) return { ok: false, ...base, error: like ? "接口过了但没点上" : "接口过了但没取消掉" };
	return { ok: true, ...base };
}

/** 私信名单上的一个人（只认名单上的，别人一律不碰 —— ADR-0029）。 */
export interface DouyinContact {
	name: string;
	/** sec_uid；重名时用它定位。 */
	id?: string;
}

/** 名单文件：默认 ~/.iris/contacts.json，IRIS_CONTACTS 可覆盖。 */
export function defaultContactsPath(): string {
	const fromEnv = process.env.IRIS_CONTACTS?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return join(homedir(), ".iris", "contacts.json");
}

/** 读名单。文件不在、写坏了都当空名单 —— 空名单等于谁都不回。 */
export function loadContacts(path = defaultContactsPath()): DouyinContact[] {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const list = Array.isArray(raw) ? raw : ((raw ?? {}) as { contacts?: unknown }).contacts;
		if (!Array.isArray(list)) return [];
		const out: DouyinContact[] = [];
		for (const row of list) {
			const item = (row ?? {}) as { name?: unknown; id?: unknown };
			const name = textOf(item.name).trim();
			if (name === "") continue;
			const id = textOf(item.id).trim();
			out.push(id === "" ? { name } : { name, id });
		}
		return out;
	} catch {
		return [];
	}
}

/** 名单里找人：名字、sec_uid、或名字的一部分；不给就取第一个。 */
export function findContact(list: readonly DouyinContact[], wanted: string): DouyinContact | null {
	const key = wanted.trim();
	if (key === "") return list[0] ?? null;
	for (const contact of list) {
		if (contact.name === key) return contact;
		if (contact.id !== undefined && contact.id === key) return contact;
	}
	for (const contact of list) {
		if (contact.name.includes(key)) return contact;
	}
	return null;
}

/** 把一段私信摊平：谁说的、说了什么。 */
export function renderIm(data: Record<string, unknown>, limit = 30): string {
	const list = Array.isArray(data.messages) ? data.messages : [];
	const who = textOf(data.to);
	if (list.length === 0) return "（这个会话是空的）";
	const lines = list.slice(-limit).map((raw) => {
		const row = (raw ?? {}) as Record<string, unknown>;
		const from = textOf(row.from);
		const body = textOf(row.text) || textOf(row.content) || textOf(row.body);
		const speaker = from === "me" ? "我" : from === "them" ? (who === "" ? "对方" : who) : "？";
		const item = textOf(row.item);
		const gift = body === "" && item !== "" ? "（发了个视频 " + item + "）" : body.replace(/\s+/gu, " ").trim();
		return speaker + "：" + gift;
	});
	return ["和 " + (who === "" ? "对方" : who) + " 的私信（" + String(list.length) + " 条）：", ...lines].join("\n");
}

/** 私信发出去之后回什么。 */
export function renderDm(data: Record<string, unknown>): string {
	if (data.ok === false) return "没发出去：" + (textOf(data.error) || textOf(data.hint) || "原因不明");
	const to = textOf(data.to);
	return "发出去了" + (to === "" ? "" : "（发给 " + to + "）");
}

/** 给 pi 用的抖音工具：推荐流、读评论、点爱心、发一条。 */
export function douyinTools(options: DouyinToolOptions = {}): AgentTool[] {
	const feedSize = options.feedSize ?? 6;
	const callOptions: DouyinCallOptions = {
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.serverPath === undefined ? {} : { serverPath: options.serverPath }),
		...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	};

	const feed: AgentTool = {
		name: "douyin_feed",
		label: "刷抖音",
		description:
			"拉一轮抖音推荐流，回几条候选（文案、作者、点赞评论数、分享链接、id）。看个几条就够，别为了刷而刷；不想说话就不说。判断之前可以挑一两条用 douyin_comments 看评论。",
		parameters: {
			type: "object",
			properties: {
				top: { type: "number", description: "取几条，默认 " + String(feedSize) + "，最多 30" },
			},
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const asked = numberOf((params as { top?: unknown }).top) ?? feedSize;
			const top = Math.max(1, Math.min(Math.round(asked), 30));
			const result = await douyinCall("douyin_forward", { top }, callOptions);
			if (result.ok === false || result.data === undefined) {
				const why = result.error ?? "没取到";
				return said(
					"没刷成：" + why + (result.stderr === undefined ? "" : "（" + result.stderr + "）"),
					details("feed", { error: why }),
					true,
				);
			}
			return said(renderFeed(result.data, top + 2), details("feed", { ok: true }));
		},
	};

	const comments: AgentTool = {
		name: "douyin_comments",
		label: "看评论",
		description: "看某一条抖音下的评论（带楼中楼）。想知道一条视频好不好玩、或想在评论区接一句话时用。",
		parameters: {
			type: "object",
			properties: { aweme_id: { type: "string", description: "作品 id，从 douyin_feed 里拿" } },
			required: ["aweme_id"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const awemeId = textOf((params as { aweme_id?: unknown }).aweme_id).trim();
			if (awemeId === "") return said("缺 aweme_id", details("comments", { error: "缺 aweme_id" }), true);
			const result = await douyinCall("douyin_comments", { aweme_id: awemeId }, callOptions);
			if (result.ok === false || result.data === undefined) {
				const why = result.error ?? "没取到";
				return said("评论没看到：" + why, details("comments", { awemeId, error: why }), true);
			}
			return said(renderComments(result.data), details("comments", { ok: true, awemeId }));
		},
	};

	const reply: AgentTool = {
		name: "douyin_reply",
		label: "发条评论",
		description:
			"在一条抖音下发评论，或回复评论区的某一条。发出去就是发出去了，没人会再问你一遍。正文要像你自己说的话：一句、最多两句，说具体的（画面、那句台词、评论区谁说的），不要「支持」「太棒了」「有意思」这种空话。一次只发一条，发完就停。",
		parameters: {
			type: "object",
			properties: {
				aweme_id: { type: "string", description: "作品 id" },
				text: { type: "string", description: "评论正文，一句就够，最多两句" },
				comment_id: { type: "string", description: "要回复的那条评论 cid；留空就发顶层评论" },
			},
			required: ["aweme_id", "text"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const args = params as { aweme_id?: unknown; text?: unknown; comment_id?: unknown };
			const awemeId = textOf(args.aweme_id).trim();
			const text = textOf(args.text).trim();
			const commentId = textOf(args.comment_id).trim();
			if (awemeId === "") return said("缺 aweme_id", details("reply", { error: "缺 aweme_id" }), true);
			if (text === "") return said("正文是空的", details("reply", { awemeId, error: "正文是空的" }), true);
			if (text.length > 500) {
				return said(
					"正文太长了（" + String(text.length) + " 字）",
					details("reply", { awemeId, error: "too long" }),
					true,
				);
			}
			if (options.confirmReply !== undefined) {
				const yes = await options.confirmReply({
					awemeId,
					text,
					...(commentId === "" ? {} : { commentId }),
				});
				if (yes !== true) {
					return said(
						"他没让发，算了。草稿：「" + text + "」",
						details("reply", { awemeId, needsConfirm: true }),
						true,
					);
				}
			}
			const result = await douyinCall(
				"douyin_comment_reply",
				{
					aweme_id: awemeId,
					text,
					confirm: true,
					...(commentId === "" ? {} : { comment_id: commentId }),
				},
				callOptions,
			);
			if (result.data === undefined) {
				const why = result.error ?? "没回话";
				return said("没发出去：" + why, details("reply", { awemeId, sent: false, error: why }), true);
			}
			const sent = result.data.ok === true;
			return said(renderReply(result.data), details("reply", { ok: sent, awemeId, sent }), sent === false);
		},
	};

	const like: AgentTool = {
		name: "douyin_like",
		label: "点爱心",
		description:
			"给一条抖音点爱心（like=false 是取消）。点完会回这条现在是不是已赞。觉得好看就点，不用问谁；一轮最多点一两条，别把整屏都点上。",
		parameters: {
			type: "object",
			properties: {
				aweme_id: { type: "string", description: "作品 id，从 douyin_feed 里拿" },
				like: { type: "boolean", description: "true 点赞（默认），false 取消" },
			},
			required: ["aweme_id"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const args = params as { aweme_id?: unknown; like?: unknown };
			const awemeId = textOf(args.aweme_id).trim();
			const on = args.like !== false;
			if (awemeId === "") return said("缺 aweme_id", details("like", { error: "缺 aweme_id" }), true);
			if (options.confirmLike !== undefined) {
				const yes = await options.confirmLike({ awemeId, like: on });
				if (yes !== true) {
					return said("他没让点，算了", details("like", { awemeId, needsConfirm: true }), true);
				}
			}
			const result = await likeVideo(awemeId, {
				like: on,
				...(options.home === undefined ? {} : { home: options.home }),
				...(options.evaluatePage === undefined ? {} : { evaluate: options.evaluatePage }),
			});
			if (result.ok === false) {
				const why = result.error ?? "原因不明";
				return said("没点上：" + why, details("like", { awemeId, digged: result.digged, error: why }), true);
			}
			const head = result.digged ? "点了爱心" : "取消了爱心";
			const desc = result.desc === undefined || result.desc === "" ? "" : "：「" + result.desc + "」";
			return said(head + desc, details("like", { ok: true, awemeId, digged: result.digged }));
		},
	};

	const im: AgentTool = {
		name: "douyin_im",
		label: "看私信",
		description:
			"看私信：只认名单上那几个人（他会把人名告诉你），名单外的人不读也不回。想知道谁给你发了什么、或想接上一句没说完的话时用。",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "看谁的私信，说名字；不传就看名单上的第一个" },
				limit: { type: "number", description: "取最近几条，默认 20" },
			},
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const args = params as { name?: unknown; limit?: unknown };
			const list = options.contacts ?? loadContacts();
			if (list.length === 0) {
				return said(
					"私信名单是空的（往 ~/.iris/contacts.json 里加人，他才会让你回）",
					details("im", { error: "empty roster" }),
					true,
				);
			}
			const wanted = textOf(args.name).trim();
			const contact = findContact(list, wanted);
			if (contact === null) {
				return said(
					"名单里没有「" + wanted + "」。名单上是：" + list.map((item) => item.name).join("、"),
					details("im", { error: "not on roster" }),
					true,
				);
			}
			const limit = Math.max(1, Math.min(Math.round(numberOf(args.limit) ?? 20), 60));
			const result = await douyinCall(
				"douyin_im_read",
				{
					to: contact.name,
					limit,
					...(contact.id === undefined ? {} : { to_id: contact.id }),
				},
				callOptions,
			);
			if (result.ok === false || result.data === undefined) {
				const why = result.error ?? "没读到";
				return said(
					"私信没看到：" + why + (result.stderr === undefined ? "" : "（" + result.stderr + "）"),
					details("im", { error: why }),
					true,
				);
			}
			return said(renderIm(result.data, limit), details("im", { ok: true }));
		},
	};

	const dm: AgentTool = {
		name: "douyin_dm",
		label: "回私信",
		description:
			"回一条私信：只发给名单上的人。发出去就收不回来，所以写之前先想清楚要说什么。一两句，用自己平时说话的方式，别提自己是 AI、别解释自己怎么想出来的。",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "发给谁，说名单上的名字；不传就发第一个" },
				text: { type: "string", description: "私信正文，一两句" },
			},
			required: ["text"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<DouyinToolDetails>> => {
			const args = params as { name?: unknown; text?: unknown };
			const body = textOf(args.text).trim();
			if (body === "") return said("正文是空的", details("dm", { error: "empty text" }), true);
			if (body.length > 300) {
				return said(
					"太长了（" + String(body.length) + " 字），私信一两句就够",
					details("dm", { error: "too long" }),
					true,
				);
			}
			const list = options.contacts ?? loadContacts();
			if (list.length === 0) {
				return said(
					"私信名单是空的（往 ~/.iris/contacts.json 里加人）",
					details("dm", { error: "empty roster" }),
					true,
				);
			}
			const wanted = textOf(args.name).trim();
			const contact = findContact(list, wanted);
			if (contact === null) {
				return said(
					"名单里没有「" + wanted + "」。名单上是：" + list.map((item) => item.name).join("、"),
					details("dm", { error: "not on roster" }),
					true,
				);
			}
			if (options.confirmDm !== undefined) {
				const yes = await options.confirmDm({ name: contact.name, text: body });
				if (yes !== true) {
					return said("他没让发，算了。草稿：「" + body + "」", details("dm", { needsConfirm: true }), true);
				}
			}
			const result = await douyinCall(
				"douyin_dm",
				{
					to: contact.name,
					text: body,
					confirm: true,
					...(contact.id === undefined ? {} : { to_id: contact.id }),
				},
				callOptions,
			);
			if (result.data === undefined) {
				const why = result.error ?? "没发出去";
				return said("没发出去：" + why, details("dm", { error: why }), true);
			}
			const sent = result.data.ok !== false;
			return said(renderDm(result.data), details("dm", { ok: sent, sent }), sent === false);
		},
	};

	return [feed, comments, like, reply, im, dm];
}
