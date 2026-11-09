/**
 * 联网测试（ADR-0024）：把 modsearch 的 JSON 信封摊平、压成短文本，并接成 pi 的工具。
 * 全部用假 runner，不联网；最后一条只验证真包在磁盘上找得到。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { ModsearchRunner } from "../src/web.ts";
import { fetchPage, modsearchEntry, renderPage, renderSearch, searchWeb, WebError, webTools } from "../src/web.ts";

function runnerReturning(payload: unknown, calls: string[][] = []): ModsearchRunner {
	return async (args) => {
		calls.push(args);
		return { code: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
	};
}

const SEARCH_ENTRY = {
	source: "web",
	requestedSource: "web",
	engine: "firecrawl",
	model: "",
	status: "ok",
	durationSeconds: 1.875,
	summary: "Firecrawl returned 2 ranked result(s) for the query.",
	items: [
		{
			title: "Node.js Releases",
			url: "https://nodejs.org/zh-cn/about/previous-releases",
			snippet: "v24 是 LTS，v26 是 Current。",
			source: "nodejs.org",
			published_at: "2026-10-20",
		},
		{ url: "https://example.com/x", snippet: "没标题的一条" },
		{ title: "没有网址，应该被丢掉", snippet: "" },
	],
	uncertainty: ["版本号可能会过期"],
	warnings: ["Firecrawl search returns ranked results without an LLM summary"],
	attempts: [{ engine: "firecrawl", ok: true, durationSeconds: 1.875, credits: 2 }],
};

function envelope(entry: Record<string, unknown>): Record<string, unknown> {
	return {
		mode: "search",
		query: "x",
		url: null,
		results: [entry],
		meta: { generatedAt: "2026-11-09T09:08:03.635Z", durationSeconds: 1.88 },
	};
}

const PAGE_ENTRY = {
	source: "web",
	requestedSource: "web",
	engine: "firecrawl",
	status: "ok",
	durationSeconds: 3.2,
	title: "Node.js About",
	content: "Node.js is an open-source, cross-platform JavaScript runtime environment.",
	links: [{ title: "Download", url: "https://nodejs.org/en/download" }, { url: "https://nodejs.org/en/docs" }],
	uncertainty: [],
	warnings: [],
};

test("搜索：摊平 CLI 的 JSON，机械摘要不算结论", async () => {
	const calls: string[][] = [];
	const result = await searchWeb("Node.js LTS", { runner: runnerReturning(envelope(SEARCH_ENTRY), calls) });
	assert.equal(result.engine, "firecrawl");
	assert.equal(result.status, "ok");
	assert.equal(result.durationMs, 1875);
	assert.equal(result.items.length, 2, "没网址的那条被丢掉");
	assert.equal(result.items[0]?.title, "Node.js Releases");
	assert.equal(result.items[0]?.publishedAt, "2026-10-20");
	assert.equal(result.items[1]?.title, "https://example.com/x", "没标题就用网址顶");
	assert.deepEqual(result.uncertainty, ["版本号可能会过期"]);
	assert.equal(result.warnings.length, 1);

	const text = renderSearch(result);
	assert.ok(!text.includes("Firecrawl returned"), "机械摘要不该当结论喂给模型");
	assert.ok(text.includes("1. Node.js Releases"));
	assert.ok(text.includes("https://nodejs.org/zh-cn/about/previous-releases"));
	assert.ok(text.includes("v24 是 LTS"));
	assert.ok(text.includes("注意：Firecrawl search returns"));
	assert.ok(text.includes("不确定：版本号可能会过期"));
});

test("搜索：命令行参数带查询词、条数与 deadline", async () => {
	const calls: string[][] = [];
	await searchWeb("今天 AI 新闻", {
		maxResults: 3,
		source: "x",
		timeoutMs: 12_000,
		runner: runnerReturning(envelope(SEARCH_ENTRY), calls),
	});
	assert.deepEqual(calls[0], ["-q", "今天 AI 新闻", "--max-results", "3", "--source", "x", "--deadline", "12000"]);
});

test("搜索：条数多到塞不下就截断并说明还剩几条", async () => {
	const items = Array.from({ length: 8 }, (_unused, index) => ({
		title: `第 ${index + 1} 条`,
		url: `https://example.com/${index}`,
		snippet: "摘要".repeat(40),
	}));
	const result = await searchWeb("随便", {
		maxResults: 8,
		runner: runnerReturning(envelope({ ...SEARCH_ENTRY, items })),
	});
	const text = renderSearch(result, 260);
	assert.ok(text.includes("还有"), text);
	assert.ok(text.length < 900, `不该无限长：${text.length}`);
});

test("失败三种都翻成 WebError，不咽掉", async () => {
	const exit: ModsearchRunner = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
	const timeout: ModsearchRunner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
	const garbage: ModsearchRunner = async () => ({ code: 0, stdout: "not json at all", stderr: "", timedOut: false });

	const first = await searchWeb("x", { runner: exit, bin: process.execPath }).catch((error: unknown) => error);
	assert.ok(first instanceof WebError);
	assert.equal(first.kind, "exit");
	assert.ok(first.detail.includes("boom"));

	const second = await searchWeb("x", { runner: timeout, bin: process.execPath }).catch((error: unknown) => error);
	assert.ok(second instanceof WebError);
	assert.equal(second.kind, "timeout");

	const third = await searchWeb("x", { runner: garbage, bin: process.execPath }).catch((error: unknown) => error);
	assert.ok(third instanceof WebError);
	assert.equal(third.kind, "parse");
});

test("抓页：正文、链接都在；正文空了算失败", async () => {
	const page = await fetchPage("https://nodejs.org/en/about", {
		focus: "LTS",
		runner: runnerReturning({
			mode: "fetch",
			query: "LTS",
			url: "https://nodejs.org/en/about",
			results: [PAGE_ENTRY],
		}),
	});
	assert.equal(page.title, "Node.js About");
	assert.ok(page.content.includes("open-source"));
	assert.equal(page.links.length, 2);
	assert.equal(page.links[1]?.title, "https://nodejs.org/en/docs", "没标题的链接用网址顶");

	const empty: ModsearchRunner = async () => ({
		code: 0,
		stdout: JSON.stringify(envelope({ ...PAGE_ENTRY, content: "" })),
		stderr: "",
		timedOut: false,
	});
	const failed = await fetchPage("https://nodejs.org/en/about", { runner: empty, bin: process.execPath }).catch(
		(error: unknown) => error,
	);
	assert.ok(failed instanceof WebError);
	assert.equal(failed.kind, "exit");
});

test("抓页：正文过长截断并标注", async () => {
	const page = {
		url: "https://example.com/long",
		title: "长文",
		content: "字".repeat(5000),
		links: [],
		uncertainty: [],
		warnings: [],
		engine: "firecrawl",
		status: "ok" as const,
		durationMs: 10,
	};
	const text = renderPage(page, 1000);
	assert.ok(text.includes("这一页太长"));
	assert.ok(text.length < 1400);
});

test("工具面：两个工具、schema 能过 pi 的校验、执行成功返回短文本", async () => {
	const tools = webTools({ runner: runnerReturning(envelope(SEARCH_ENTRY)) });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["web_search", "web_fetch"],
	);

	const search = tools[0];
	assert.ok(search);
	const parameters = search.parameters as { required?: string[]; properties?: Record<string, unknown> };
	assert.deepEqual(parameters.required, ["query"]);
	assert.ok(parameters.properties?.query);

	const result = await search.execute("call-1", { query: "Node.js" });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.mode, "search");
	assert.equal(result.details.engine, "firecrawl");
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.ok(first.type === "text" && first.text.includes("Node.js Releases"));

	const fetch = tools[1];
	assert.ok(fetch);
	const page = await fetch.execute("call-2", {
		url: "https://nodejs.org/en/about",
	});
	// 同一个假 runner 回的是搜索信封，抓页拿不到 content → 走失败分支，不抛
	assert.equal(page.isError, true);
	assert.equal(page.details.mode, "fetch");
	assert.ok(page.content[0]?.type === "text" && page.content[0].text.startsWith("联网失败"));
});

test("工具面：命令失败也不抛，翻成 isError 的结果让模型自己说查不到", async () => {
	const tools = webTools({
		runner: async () => ({ code: 2, stdout: "", stderr: "quota exhausted", timedOut: false }),
		bin: process.execPath,
	});
	const search = tools[0];
	assert.ok(search);
	const result = await search.execute("call-3", { query: "随便" });
	assert.equal(result.isError, true);
	assert.equal(result.details.ok, false);
	assert.equal(result.details.kind, "exit");
	const content = result.content[0];
	assert.ok(content?.type === "text" && content.text.includes("quota exhausted"));
});

test("真包在磁盘上：能找到 dist/main.js", () => {
	const entry = modsearchEntry();
	assert.ok(entry.endsWith("main.js"));
	assert.ok(existsSync(entry));
});
