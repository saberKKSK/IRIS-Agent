import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { type RawTurn, SqliteArchive } from "../src/archive.ts";

const DAY = 86_400_000;
const START = 1_760_000_000_000;

function turn(role: RawTurn["role"], content: string, at: number): RawTurn {
	return { role, content, at };
}

function chat(...texts: string[]): RawTurn[] {
	return texts.map((text, index) => turn(index % 2 === 0 ? "user" : "assistant", text, START + index * 1000));
}

interface MakeOptions {
	now?: () => number;
	ordinaryTtlDays?: number;
	recallBudgetTokens?: number;
	hotHits?: number;
}

function make(overrides: MakeOptions = {}): { archive: SqliteArchive; advance: (ms: number) => void } {
	let now = START;
	const archive = new SqliteArchive({
		path: ":memory:",
		now: () => now,
		...overrides,
	});
	return {
		archive,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("原文归档", () => {
	it("写进去就是原文，脱敏后落库", async () => {
		const { archive } = make();
		const { conversationId } = await archive.ingest({
			sessionId: "s1",
			turns: chat("我电话 13800138000，邮箱 me@example.com，key sk-abcdefgh1234", "好的，记下了"),
		});
		const messages = archive.messagesOf(conversationId);
		assert.equal(messages.length, 2);
		assert.ok(messages[0]?.content.includes("***"), "手机号应被打码");
		assert.ok(!messages[0]?.content.includes("13800138000"));
		assert.ok(!messages[0]?.content.includes("me@example.com"));
		assert.ok(!messages[0]?.content.includes("sk-abcdefgh1234"));
	});

	it("messages 表在数据库层禁止改和删", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-archive-"));
		const path = join(dir, "test.db");
		try {
			const archive = new SqliteArchive({ path, now: () => START });
			const { conversationId } = await archive.ingest({ sessionId: "s1", turns: chat("你好", "在的") });
			archive.close();

			const raw = new DatabaseSync(path);
			assert.throws(() => raw.exec("UPDATE messages SET content = 'x'"), /append-only/);
			assert.throws(() => raw.exec("DELETE FROM messages"), /append-only/);
			raw.close();
			void conversationId;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("三档", () => {
	it("用户说记住 → critical 且 locked", async () => {
		const { archive } = make();
		const { tier, memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("记住这个：我生日是 3 月 12 号", "好，记下了"),
		});
		assert.equal(tier.tier, "critical");
		assert.equal(memories[0]?.status, "locked");
		assert.equal(memories[0]?.expiresAt, null);
	});

	it("跨多轮或含长期约定 → medium，直接生效、永不过期", async () => {
		const { archive } = make();
		const { tier, memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("周末有空吗", "有", "那一起去看海？", "好"),
		});
		assert.equal(tier.tier, "medium");
		assert.equal(memories[0]?.status, "active");
		assert.equal(memories[0]?.expiresAt, null, "中等档不该到期");
		assert.ok(archive.recall("看海").hits.length >= 1, "落库即可检索，不需要谁点确认");
	});

	it("例行闲聊 → ordinary，30 天后过期", async () => {
		const { archive } = make();
		const { tier, memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("今天下班有点累", "那就不说，我在"),
		});
		assert.equal(tier.tier, "ordinary");
		const memory = memories[0];
		assert.equal(memory?.status, "active");
		assert.equal(memory?.expiresAt, START + 30 * DAY);
	});
});

describe("要改就改，不用审批", () => {
	it("amend 改正文并留下审计记录", () => {
		const { archive } = make();
		const memory = archive.remember({ text: "他喜欢看海" });
		const amended = archive.amend(memory.id, "他喜欢海，不一定喜欢看", "human");
		assert.equal(amended.text, "他喜欢海，不一定喜欢看");
		assert.equal(amended.status, "active");
		const history = archive.histories(memory.id);
		assert.equal(history.length, 1);
		assert.equal(history[0]?.before, "他喜欢看海");
		assert.equal(history[0]?.after, "他喜欢海，不一定喜欢看");
	});

	it("promote 锁成重要档，drop 直接作废", () => {
		const { archive } = make();
		const memory = archive.remember({ text: "他妈生日是十月" });
		const promoted = archive.promote(memory.id);
		assert.equal(promoted.tier, "critical");
		assert.equal(promoted.status, "locked");
		assert.equal(promoted.expiresAt, null);

		const dropped = archive.drop(memory.id);
		assert.equal(dropped.status, "expired");
		assert.equal(archive.recall("生日").hits.length, 0, "作废后检索不到");
	});

	it("改不存在的记忆直接报错", () => {
		const { archive } = make();
		assert.throws(() => archive.amend("mem-nope", "x"), /memory not found/);
	});
});

describe("检索（无向量）", () => {
	it("中文关键词能召回，单字兜底也生效", async () => {
		const { archive } = make();
		await archive.ingest({ sessionId: "s1", turns: chat("周六一起去看了海，风很大", "记得") });
		await archive.ingest({ sessionId: "s1", turns: chat("他说想养一只布偶猫，但房东不让", "那先不养") });

		const sea = archive.recall("看海");
		assert.ok(sea.hits.length >= 1);
		assert.ok(sea.text.includes("看了海"));
		assert.ok(sea.budget.limit > 0);
		assert.ok(sea.usedTokens > 0);

		const cat = archive.recall("猫");
		assert.ok(cat.hits.length >= 1);
		assert.ok(cat.text.includes("布偶猫"));
	});

	it("召回为空时返回空，不编造", () => {
		const { archive } = make();
		const result = archive.recall("量子计算机");
		assert.equal(result.hits.length, 0);
		assert.equal(result.text, "");
	});

	it("预算上限会截断并如实报告", async () => {
		const { archive } = make({ recallBudgetTokens: 40 });
		for (let index = 0; index < 6; index += 1) {
			await archive.ingest({
				sessionId: "s1",
				turns: chat("今天在公司加班到十点，累得不想说话，路上还下了雨", "早点睡"),
			});
		}
		const result = archive.recall("加班 累", { limit: 6 });
		assert.ok(result.hits.length >= 1);
		assert.ok(result.hits.length < 6, "预算应截断结果");
		assert.equal(result.budget.used, result.usedTokens);
	});
});

describe("过期与遗忘", () => {
	it("普通档到期只删提炼条，原文不动", async () => {
		const { archive, advance } = make();
		const { conversationId } = await archive.ingest({
			sessionId: "s1",
			turns: chat("今天下班有点累", "那就不说，我在"),
		});
		advance(31 * DAY);
		const swept = archive.sweep();
		assert.equal(swept.expired, 1);
		assert.equal(archive.messagesOf(conversationId).length, 2, "原文必须还在");
		assert.equal(archive.stats().byTier.ordinary, 0);
	});

	it("被反复命中的普通档自动升到中等档", async () => {
		const { archive } = make({ hotHits: 3 });
		const { memories } = await archive.ingest({
			sessionId: "s1",
			turns: chat("今天下班有点累", "那就不说，我在"),
		});
		const memory = memories[0];
		assert.ok(memory);
		for (let index = 0; index < 3; index += 1) archive.recall("累");
		const swept = archive.sweep();
		assert.equal(swept.promoted, 1);
		const after = archive.timeline(START - DAY).find((row) => row.id === memory.id);
		assert.equal(after?.tier, "medium");
		assert.equal(after?.status, "active");
		assert.equal(after?.expiresAt, null, "升级后不再过期");
	});

	it("forget 删掉整段会话（人才能调用）", async () => {
		const { archive } = make();
		const { conversationId } = await archive.ingest({ sessionId: "s1", turns: chat("记住这个：秘密", "好") });
		const removed = archive.forget(conversationId);
		assert.equal(removed.messages, 2);
		assert.equal(archive.messagesOf(conversationId).length, 0);
		assert.equal(archive.stats().messages, 0);
	});
});

describe("文件库与开场注入", () => {
	it("关掉再打开，原文与记忆都还在", async () => {
		const dir = mkdtempSync(join(tmpdir(), "iris-archive-"));
		const path = join(dir, "nested", "iris.db");
		try {
			const first = new SqliteArchive({ path, now: () => START });
			const { conversationId } = await first.ingest({
				sessionId: "iris",
				turns: chat("我下周要去青岛看海", "好啊，到时候说给我听"),
			});
			first.close();

			const second = new SqliteArchive({ path, now: () => START + DAY });
			try {
				assert.equal(second.messagesOf(conversationId).length, 2);
				const kept = second.timeline(START - 1);
				assert.ok(kept.length >= 1);
				assert.ok(kept.some((memory) => memory.text.includes("青岛")));
			} finally {
				second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("开场注入：重要档排最前，中等档也在（都是直接生效的）", async () => {
		const { archive } = make();
		archive.remember({ text: "他喜欢看海" });
		await archive.ingest({ sessionId: "iris", turns: chat("记住，我生日是三月七号", "记下了，三月七号") });

		const rows = archive.essential(5);
		assert.ok(rows.length >= 2);
		assert.equal(rows[0]?.tier, "critical");
		assert.ok(rows.some((memory) => memory.text.includes("看海")));
		assert.ok(rows.every((memory) => memory.status === "active" || memory.status === "locked"));
	});
});
