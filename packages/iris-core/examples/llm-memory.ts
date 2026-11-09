/**
 * 规则版 vs 模型版：同一段对话，两条记忆链路各跑一遍。
 *
 * 用法：node examples/llm-memory.ts
 *
 * 规则版只认关键词和多轮数，写进库的是整段流水；
 * 模型版先分档、再提炼成短事实，quote 必须是原文里的句子（不在就丢）。
 * 两个库都是 :memory:，不碰 ~/.iris/iris.db。
 */

import { llmMemory, type MemoryRecord, SqliteArchive, type TierDecision } from "../src/index.ts";

const CONVERSATION = [
	{ role: "user" as const, content: "记住这个：我对花生过敏，别给我点带花生的东西。", delay: 0 },
	{
		role: "assistant" as const,
		content: "记住了，花生不碰。那家川菜馆的宫保鸡丁以后也不提了。",
		delay: 1000,
	},
	{ role: "user" as const, content: "这周连着加班，周六想在家躺着。", delay: 2000 },
	{ role: "assistant" as const, content: "那就躺着吧，我不吵你。", delay: 3000 },
];

function turnsOf() {
	const at = Date.now() - 60_000;
	return CONVERSATION.map((turn) => ({ role: turn.role, content: turn.content, at: at + turn.delay }));
}

async function run(
	label: string,
	options: { llm: boolean },
): Promise<{
	tier: TierDecision;
	memories: readonly MemoryRecord[];
	ms: number;
	errors: string[];
}> {
	const errors: string[] = [];
	const archive = new SqliteArchive({
		path: ":memory:",
		...(options.llm
			? llmMemory({
					onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
				})
			: {}),
	});
	const started = Date.now();
	const { tier, memories } = await archive.ingest({ sessionId: "example", turns: turnsOf() });
	const ms = Date.now() - started;
	archive.close();
	console.log("--- " + label + " ---");
	console.log("分档  " + tier.tier + "（" + tier.reason + "，来源 " + tier.source + "）");
	console.log("耗时  " + ms + " ms");
	for (const memory of memories) {
		console.log("记忆  [" + memory.status + "] " + memory.text);
		console.log("      原文支持：" + (memory.quote ?? "（无）"));
	}
	if (errors.length > 0) console.log("回落  " + errors.join("; "));
	console.log("");
	return { tier, memories, ms, errors };
}

const rule = await run("规则版", { llm: false });
const llm = await run("模型版", { llm: true });
console.log("规则版第一条  " + (rule.memories[0]?.text ?? "（空）"));
console.log("模型版第一条  " + (llm.memories[0]?.text ?? "（空）"));
