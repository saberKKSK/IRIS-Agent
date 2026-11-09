/**
 * 联网体检：不经模型，直接看 modsearch 能不能用（ADR-0024）。
 *
 *   node examples/web.ts                      默认搜一句
 *   node examples/web.ts "今天有什么 AI 新闻"
 *   node examples/web.ts --url https://nodejs.org/en/about
 */

import { fetchPage, modsearchEntry, renderPage, renderSearch, searchWeb } from "../src/web.ts";

const args = process.argv.slice(2);
const at = (name: string): string | undefined => {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
};

console.log(`modsearch：${modsearchEntry()}`);

const url = at("--url");
if (url !== undefined) {
	const page = await fetchPage(url);
	console.log(`模式：抓页 · ${page.engine ?? "未知"} · ${page.durationMs} ms · ${page.content.length} 字`);
	console.log("---");
	console.log(renderPage(page));
	process.exit(0);
}

const query =
	args
		.filter((arg) => !arg.startsWith("--"))
		.join(" ")
		.trim() || "今天有什么 AI 新闻";
const result = await searchWeb(query, { maxResults: 5 });
console.log(
	`模式：搜索 · ${result.engine ?? "未知"} · ${result.status} · ${result.durationMs} ms · ${result.items.length} 条`,
);
console.log("---");
console.log(renderSearch(result));
