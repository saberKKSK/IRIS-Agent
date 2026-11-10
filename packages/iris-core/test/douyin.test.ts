/**
 * 抖音通路（ADR-0027）：MCP 子进程握手、推荐流怎么摊、评论怎么读、发之前必须人点头。
 * 全部打自造的假服务器，不碰真账号、不联网、不发任何东西。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { DouyinToolDetails } from "../src/douyin.ts";
import {
	diggExpression,
	douyinCall,
	douyinTools,
	findContact,
	likeVideo,
	loadContacts,
	renderComments,
	renderDm,
	renderFeed,
	renderIm,
	renderReply,
} from "../src/douyin.ts";

const sandbox = mkdtempSync(join(tmpdir(), "iris-douyin-"));
after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

/** 假 MCP 服务器：照 MCP 的形状回话，把每次调用追加到 calls.log 里。 */
const STUB = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.STUB_LOG || ''
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
	const msg = JSON.parse(line)
	if (msg.method === 'initialize') {
		send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } })
		return
	}
	if (msg.method !== 'tools/call') return
	const name = msg.params?.name
	const args = msg.params?.arguments || {}
	if (log) appendFileSync(log, JSON.stringify({ name, args }) + '\\n')
	const payload = name === 'douyin_forward'
		? { ok: true, list: [{ aweme_id: '7100', desc: '猫在打呼', author: '阿远', digg: 12, comment: 3, age_h: 2, share_url: 'https://v.douyin.com/x/' }] }
		: name === 'douyin_comments'
			? { ok: true, count: 2, comments: ['cid=1 甲：真好笑', '      └ cid=2 乙：+1'] }
			: name === 'douyin_im_read'
				? { ok: true, to: args.to || 'Walk away', messages: [{ from: 'them', text: '在干嘛' }, { from: 'me', text: '看戏' }, { from: 'them', text: '什么戏' }] }
				: name === 'douyin_dm'
					? { ok: true, to: args.to || '', sent: true }
					: { ok: true, cid: '999', echo: args }
	send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })
})
`;

const stubPath = join(sandbox, "stub-mcp.mjs");
const logPath = join(sandbox, "calls.log");
writeFileSync(stubPath, STUB, "utf8");
process.env.STUB_LOG = logPath;

function textOf(result: AgentToolResult<DouyinToolDetails>): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text : "";
}

function tool(tools: ReturnType<typeof douyinTools>, name: string) {
	const found = tools.find((item) => item.name === name);
	assert.ok(found !== undefined, name + " 没接上");
	return found;
}

test("MCP 子进程：握手之后 tools/call 能拿到 JSON", async () => {
	const result = await douyinCall(
		"douyin_forward",
		{ top: 3 },
		{ serverPath: stubPath, home: sandbox, timeoutMs: 20_000 },
	);
	assert.equal(result.ok, true);
	assert.equal(Array.isArray(result.data?.list), true);
});

test("推荐流：摊成能判断的几行，带 id 和链接", async () => {
	const tools = douyinTools({ serverPath: stubPath, home: sandbox, timeoutMs: 20_000 });
	const result = await tool(tools, "douyin_feed").execute("t1", { top: 1 });
	assert.equal(result.isError, undefined);
	const text = textOf(result);
	assert.match(text, /猫在打呼/u);
	assert.match(text, /id=7100/u);
	assert.match(text, /https:\/\/www\.douyin\.com\/video\/7100/u);
	assert.match(text, /赞12/u);
});

test("读评论：把楼中楼一起摊平", async () => {
	const tools = douyinTools({ serverPath: stubPath, home: sandbox, timeoutMs: 20_000 });
	const result = await tool(tools, "douyin_comments").execute("t1", { aweme_id: "7100" });
	const text = textOf(result);
	assert.match(text, /共 2 条/u);
	assert.match(text, /真好笑/u);
	assert.match(text, /\+1/u);
});

test("发评论：默认不问人，直接发出去（ADR-0028）", async () => {
	rmSync(logPath, { force: true });
	const tools = douyinTools({ serverPath: stubPath, home: sandbox, timeoutMs: 20_000 });
	const result = await tool(tools, "douyin_reply").execute("t1", { aweme_id: "7100", text: "这猫像我上班" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /发出去了/u);
	const calls = readFileSync(logPath, "utf8").trim().split("\n");
	const sent = JSON.parse(calls[calls.length - 1] ?? "{}") as { name?: string; args?: { confirm?: boolean } };
	assert.equal(sent.name, "douyin_comment_reply");
	assert.equal(sent.args?.confirm, true);
});

test("发评论：挂了闸门就问人，点头才发", async () => {
	rmSync(logPath, { force: true });
	let asked = "";
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		confirmReply: (request) => {
			asked = request.text;
			return true;
		},
	});
	const result = await tool(tools, "douyin_reply").execute("t1", { aweme_id: "7100", text: "这猫像我上班" });
	assert.equal(result.isError, undefined);
	assert.equal(asked, "这猫像我上班");
	assert.match(textOf(result), /发出去了/u);
	const calls = readFileSync(logPath, "utf8").trim().split("\n");
	const sent = JSON.parse(calls[calls.length - 1] ?? "{}") as { name?: string; args?: { confirm?: boolean } };
	assert.equal(sent.name, "douyin_comment_reply");
	assert.equal(sent.args?.confirm, true);
});

test("发评论：闸门后面的人不同意就停手", async () => {
	rmSync(logPath, { force: true });
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		confirmReply: () => false,
	});
	const result = await tool(tools, "douyin_reply").execute("t1", { aweme_id: "7100", text: "算了" });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /他没让发/u);
	assert.equal(existsSync(logPath), false);
});

test("渲染助手：空清单、空评论、发送失败的兜底说法", () => {
	assert.equal(renderFeed({ list: [] }), "（这一轮什么也没取到）");
	assert.equal(renderComments({ comments: [] }), "（评论区是空的，或者没取到）");
	assert.match(renderReply({ ok: false, error: "楼根判不出来" }), /没发出去：楼根判不出来/u);
});

test("点爱心：页面里 POST digg，再读 detail 的 user_digged 核对", async () => {
	let seen = "";
	const result = await likeVideo("7001", {
		evaluate: async (expression) => {
			seen = expression;
			return { status: 0, digged: 1, digg: 1835988, desc: "猫在打呼" };
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.digged, true);
	assert.equal(result.desc, "猫在打呼");
	assert.match(seen, /commit\/item\/digg/u);
	assert.match(seen, /aweme\/detail/u);
	assert.match(seen, /7001/u);
});

test("点爱心：接口回 0 但状态没变，算没点上", async () => {
	const result = await likeVideo("7001", { evaluate: async () => ({ status: 0, digged: 0 }) });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /没点上/u);
});

test("点爱心：接口没认（未登录之类）把原因带回来", async () => {
	const result = await likeVideo("7001", {
		evaluate: async () => ({ status: 8, message: "用户未登录", digged: 0 }),
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /用户未登录/u);
});

test("点爱心：页面里报错不抛，翻成一句话", async () => {
	const result = await likeVideo("7001", {
		evaluate: async () => {
			throw new Error("没开成抖音页面");
		},
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /没开成抖音页面/u);
});

test("digg 表达式：点赞写 1，取消写 0", () => {
	assert.match(diggExpression("7001", true), /const on = true/u);
	assert.match(diggExpression("7001", false), /const on = false/u);
	assert.match(diggExpression("7001", true), /credentials: 'include'/u);
});

test("点爱心工具：默认不问人，直接点", async () => {
	const exprs: string[] = [];
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		evaluatePage: async (expression) => {
			exprs.push(expression);
			return { status: 0, digged: 1, desc: "猫在打呼" };
		},
	});
	const result = await tool(tools, "douyin_like").execute("t1", { aweme_id: "7100" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /点了爱心/u);
	assert.equal(result.details.digged, true);
	assert.equal(exprs.length, 1);
});

test("点爱心工具：闸门说不点，就连页面都不碰", async () => {
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		confirmLike: () => false,
		evaluatePage: async () => {
			throw new Error("不该被调用");
		},
	});
	const result = await tool(tools, "douyin_like").execute("t1", { aweme_id: "7100" });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /没让点/u);
});

test("点爱心工具：取消爱心，文案跟着变", async () => {
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		evaluatePage: async () => ({ status: 0, digged: 0, desc: "猫在打呼" }),
	});
	const result = await tool(tools, "douyin_like").execute("t1", { aweme_id: "7100", like: false });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /取消了爱心/u);
});

test("名单：文件读得进来，缺文件当空名单，名字/id/半截名都找得到", () => {
	const file = join(sandbox, "contacts.json");
	writeFileSync(file, JSON.stringify({ contacts: [{ name: "Walk away", id: "MS4wLjABAAAA_p" }, { name: "阿远" }] }));
	const list = loadContacts(file);
	assert.equal(list.length, 2);
	assert.equal(findContact(list, "Walk away")?.id, "MS4wLjABAAAA_p");
	assert.equal(findContact(list, "MS4wLjABAAAA_p")?.name, "Walk away");
	assert.equal(findContact(list, "远")?.name, "阿远");
	assert.equal(findContact(loadContacts(join(sandbox, "nope.json")), "谁"), null);
});

test("看私信：名单外的人不读，名单上的人读得到", async () => {
	const roster = [{ name: "Walk away", id: "MS4wLjABAAAA_p" }];
	const tools = douyinTools({ serverPath: stubPath, home: sandbox, timeoutMs: 20_000, contacts: roster });
	const stranger = await tool(tools, "douyin_im").execute("t1", { name: "陌生人" });
	assert.equal(stranger.isError, true);
	assert.match(textOf(stranger), /名单里没有/u);

	const ok = await tool(tools, "douyin_im").execute("t1", {});
	const text = textOf(ok);
	assert.match(text, /Walk away/u);
	assert.match(text, /Walk away：在干嘛/u);
	assert.match(text, /我：看戏/u);
});

test("回私信：默认不问人，带上 to_id 和 confirm", async () => {
	rmSync(logPath, { force: true });
	const roster = [{ name: "Walk away", id: "MS4wLjABAAAA_p" }];
	const tools = douyinTools({ serverPath: stubPath, home: sandbox, timeoutMs: 20_000, contacts: roster });
	const result = await tool(tools, "douyin_dm").execute("t1", { text: "在看戏，等会儿说" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /发出去了/u);
	const calls = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
	const call = calls[calls.length - 1];
	assert.equal(call?.name, "douyin_dm");
	assert.equal(call?.args.to, "Walk away");
	assert.equal(call?.args.to_id, "MS4wLjABAAAA_p");
	assert.equal(call?.args.confirm, true);
});

test("回私信：挂了闸门、人不同意就停手", async () => {
	rmSync(logPath, { force: true });
	const roster = [{ name: "Walk away" }];
	const tools = douyinTools({
		serverPath: stubPath,
		home: sandbox,
		timeoutMs: 20_000,
		contacts: roster,
		confirmDm: () => false,
	});
	const result = await tool(tools, "douyin_dm").execute("t1", { text: "晚安" });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /没让发/u);
	assert.equal(existsSync(logPath), false);
});

test("私信渲染：空会话、发失败都说得清楚", () => {
	assert.match(renderIm({ to: "阿远", messages: [] }), /空的/u);
	assert.match(renderDm({ ok: false, error: "目标不在会话列表" }), /没发出去/u);
	assert.match(renderDm({ ok: true, to: "阿远" }), /发给 阿远/u);
});
