/**
 * 记忆生命周期演示（ADR-0014 / ADR-0015 / ADR-0016）：
 * 三档分类 → 落库即生效（没有待确认）→ 无向量检索 → 热记忆自动升级 → 普通档过期 → 原文仍在。
 *
 * 跑法：npm run demo:archive
 */

import { type RawTurn, SqliteArchive } from "../src/index.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = new Date("2026-11-09T21:00:00+08:00").getTime();

let now = T0;
const archive = new SqliteArchive({ path: ":memory:", now: () => now });

function turn(role: RawTurn["role"], content: string, offset: number): RawTurn {
	return { role, content, at: T0 + offset };
}

function line(text = ""): void {
	console.log(text);
}

line("=== 1. 三次会话，分别落进三档 ===");

const chat1 = await archive.ingest({
	sessionId: "s1",
	turns: [turn("user", "今天下班有点累，不太想说话", 0), turn("assistant", "那就不说，我在这儿。", 1_000)],
});
line(`例行闲聊 → ${chat1.tier.tier}（${chat1.tier.reason}）`);

const chat2 = await archive.ingest({
	sessionId: "s1",
	turns: [
		turn("user", "周末有空吗？", HOUR),
		turn("assistant", "有。", HOUR + 1_000),
		turn("user", "那一起去看海？风大也别管。", HOUR + 2_000),
		turn("assistant", "去。我记着了。", HOUR + 3_000),
	],
});
line(`多轮约定 → ${chat2.tier.tier}（${chat2.tier.reason}）`);

const chat3 = await archive.ingest({
	sessionId: "s1",
	turns: [turn("user", "记住这个：我对花生过敏，别给我点带花生的", DAY), turn("assistant", "记下了，花生不行。", DAY + 1_000)],
});
line(`明确要求记住 → ${chat3.tier.tier}（${chat3.tier.reason}）`);

const chat4 = await archive.ingest({
	sessionId: "s1",
	turns: [turn("user", "今天风挺大", 2 * HOUR), turn("assistant", "是啊，别开窗。", 2 * HOUR + 1_000)],
});

line();
line("=== 2. 落库即生效：没有待确认，也不会有谁被卡住 ===");
for (const chat of [chat1, chat2, chat3, chat4]) {
	for (const memory of chat.memories) {
		const expires = memory.expiresAt === null ? "永不过期" : new Date(memory.expiresAt).toISOString().slice(0, 10);
		line(`  · [${memory.tier}/${memory.status}] ${memory.text}`);
		line(`    过期：${expires}　原文支持：${memory.quote ?? "（无）"}`);
	}
}

line();
line("=== 3. 没有向量库也能查（FTS5 单字 + 二元组）===");
for (const query of ["看海", "花生", "累"]) {
	const started = performance.now();
	const result = archive.recall(query);
	const cost = (performance.now() - started).toFixed(2);
	line(`  查「${query}」用了 ${cost} ms，命中 ${result.hits.length} 条，预算 ${result.budget.used}/${result.budget.limit} tokens`);
	if (result.text.length > 0) line(result.text.split("\n").map((row) => "    " + row).join("\n"));
}

line();
line("=== 4. 反复被想起的普通档：自动升到中等档，不再问人 ===");
for (let i = 0; i < 4; i += 1) archive.recall("累");
const promoted = archive.sweep();
line(`  又想起 4 次（累计命中 5 次）→ sweep：升级 ${promoted.promoted} 条`);
for (const memory of archive.timeline(10).filter((row) => row.hits >= 5)) {
	line(`  · [${memory.tier}/${memory.status}] ${memory.text}（hits=${memory.hits}，过期：${memory.expiresAt === null ? "永不过期" : "有"})`);
}

line();
line("=== 5. 过 31 天：普通档提炼条被清掉，原文一条不少 ===");
now = T0 + 31 * DAY;
const swept = archive.sweep();
line(`  sweep: 过期 ${swept.expired} 条，升级 ${swept.promoted} 条`);
line(`  原文仍在：${chat4.conversationId} → ${archive.messagesOf(chat4.conversationId).length} 条消息`);

line();
line("=== 6. 要改就改，不用走审批（amend / promote / drop 直接生效）===");
const first = archive.timeline(10)[0];
if (first !== undefined) {
	const amended = archive.amend(first.id, first.text + "（改过）", "demo");
	line(`  amend  → ${amended.text}`);
	const promotedRow = archive.promote(first.id);
	line(`  promote→ [${promotedRow.tier}/${promotedRow.status}] 永不过期：${promotedRow.expiresAt === null}`);
	const dropped = archive.drop(first.id);
	line(`  drop   → status=${dropped.status}`);
}

const stats = archive.stats();
line();
line("=== 7. 账本 ===");
line(`  会话 ${stats.conversations} 段 / 原文 ${stats.messages} 条`);
line(`  按档：普通 ${stats.byTier.ordinary} · 中等 ${stats.byTier.medium} · 重要 ${stats.byTier.critical}`);
line(`  按状态：active ${stats.byStatus.active} · locked ${stats.byStatus.locked} · expired ${stats.byStatus.expired}`);

archive.close();
