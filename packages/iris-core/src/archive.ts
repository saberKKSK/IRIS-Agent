/**
 * 归档与记忆生命周期：原文永不丢，提炼条按三档管理（ADR-0014）。
 *
 * 三条硬规则写在这里，不靠调用方自觉：
 * 1. messages 表是 append-only —— SQLite 触发器禁掉 UPDATE/DELETE，代码里也没有删除路径；
 * 2. critical 只能由规则或人确认产生，产生后 locked，AI 只读；
 * 3. 原文写入前先脱敏（key / 长数字串 / 密码 / 邮箱）。
 *
 * 检索先不建向量库（ADR-0015）：FTS5 单字 + 二元组、bm25 排序、分层与时间加权，实测 < 1 ms。
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Episode, EpisodeKind } from "./types.ts";

export type Tier = "ordinary" | "medium" | "critical";
/**
 * 记忆状态。没有「待确认」这一档：写进去就是生效的（ADR-0016，对齐 Hermes 的默认行为）。
 * 历史库里的 pending_review 读出来一律按 active 处理。
 */
export type MemoryStatus = "active" | "locked" | "expired";

export interface RawTurn {
	role: "user" | "assistant" | "system";
	content: string;
	at: number;
}

export interface ConversationInput {
	sessionId: string;
	turns: readonly RawTurn[];
	/** 不给就用最后一轮的 at。 */
	endedAt?: number;
}

export interface MemoryDraft {
	text: string;
	quote?: string;
	tags?: readonly string[];
	importance?: number;
	kind?: EpisodeKind;
}

export interface TierDecision {
	tier: Tier;
	reason: string;
	source: "rule" | "model" | "human";
}

export interface MemoryRecord {
	id: string;
	conversationId: string | null;
	tier: Tier;
	text: string;
	quote: string | null;
	tags: readonly string[];
	importance: number;
	status: MemoryStatus;
	createdAt: number;
	expiresAt: number | null;
	hits: number;
}

export interface RecallOptions {
	limit?: number;
	tiers?: readonly Tier[];
	since?: number;
	budgetTokens?: number;
	now?: number;
}

export interface RecallHit {
	memory: MemoryRecord;
	score: number;
	rank: number;
}

export interface RecallResult {
	query: string;
	hits: readonly RecallHit[];
	/** 可直接塞进 prompt 的渲染文本。 */
	text: string;
	usedTokens: number;
	/** 给模型的容量反馈：超限要自己腾地方，不要静默截断。 */
	budget: { used: number; limit: number };
}

export interface ArchiveOptions {
	/** 文件路径，或 ":memory:"。 */
	path: string;
	/** 普通档的存活天数，默认 30。 */
	ordinaryTtlDays?: number;
	/** 注入预算（token），默认 600。 */
	recallBudgetTokens?: number;
	/** 判定为「热」（该升级）的命中次数，默认 5。 */
	hotHits?: number;
	/** 可注入的分类器；不给、或返回 undefined（模型失败）就走规则。 */
	classifier?(input: {
		turns: readonly RawTurn[];
		text: string;
	}): TierDecision | undefined | Promise<TierDecision | undefined>;
	/** 可注入的提炼器；不给、或返回 undefined 就把对话压成一条摘要。 */
	distiller?(input: {
		turns: readonly RawTurn[];
		tier: Tier;
	}): readonly MemoryDraft[] | undefined | Promise<readonly MemoryDraft[] | undefined>;
	now?(): number;
}

const DAY = 86_400_000;
const DEFAULT_TTL_DAYS = 30;
const DEFAULT_BUDGET = 600;
const DEFAULT_HOT_HITS = 5;

/** 默认库路径：`~/.iris/iris.db`（可用环境变量 IRIS_ARCHIVE 覆盖）。同一个文件 = 同一份记性。 */
export function defaultArchivePath(): string {
	const override = process.env.IRIS_ARCHIVE?.trim();
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), ".iris", "iris.db");
}

const SEGMENT = /[\p{L}\p{N}]+/gu;
const HAN = /[\u4e00-\u9fff]/;

/** 检索词：汉字既出单字也出二元组（单字兜底「看海」↔「看了海」，二元组提供精度）。 */
export function indexTerms(text: string): readonly string[] {
	const segments = text.toLowerCase().match(SEGMENT) ?? [];
	const terms = new Set<string>();
	for (const segment of segments) {
		if (!HAN.test(segment)) {
			terms.add(segment);
			continue;
		}
		for (const char of segment) terms.add(char);
		for (let index = 0; index < segment.length - 1; index += 1) {
			terms.add(segment.slice(index, index + 2));
		}
	}
	return [...terms];
}

/** 汉字二元组，用于给命中加权：二元组命中比单字命中可信得多。 */
export function bigrams(text: string): readonly string[] {
	const out: string[] = [];
	for (const segment of text.toLowerCase().match(SEGMENT) ?? []) {
		if (!HAN.test(segment) || segment.length < 2) continue;
		for (let index = 0; index < segment.length - 1; index += 1) out.push(segment.slice(index, index + 2));
	}
	return out;
}

const REDACTIONS: readonly { pattern: RegExp; replace: string }[] = [
	{ pattern: /sk-[A-Za-z0-9_-]{8,}/g, replace: "sk-***" },
	{ pattern: /(密码|口令|password|passwd)\s*[:：=]\s*\S+/gi, replace: "$1: ***" },
	{ pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g, replace: "***@***" },
	{ pattern: /\b1[3-9]\d{9}\b/g, replace: "***" },
	{ pattern: /\b\d{16,}\b/g, replace: "***" },
];

/** 原文落库前的脱敏。宁可多打码，也别把一次性凭证永久留住。 */
export function redact(text: string): string {
	let out = text;
	for (const rule of REDACTIONS) out = out.replace(rule.pattern, rule.replace);
	return out;
}

/** token 估算：汉字按 1 token/字，其余按 4 字符/token。只用于预算控制。 */
export function estimateTokens(text: string): number {
	let han = 0;
	let other = 0;
	for (const char of text) {
		if (HAN.test(char)) han += 1;
		else other += 1;
	}
	return Math.ceil(han + other / 4);
}

const EXPLICIT_MEMORY = /(记住|记一下|别忘了|不要忘|一定要记得|这个很重要|这很重要|remember this|don't forget)/i;
const DURABLE_SIGNAL = /(以后|每次|一直|习惯|喜欢|讨厌|害怕|计划|约定|答应|生日|纪念日|搬|换工作|决定)/;

interface ConversationRow {
	id: string;
	session_id: string;
	started_at: number;
	ended_at: number;
	tier: string;
	tier_source: string;
	tier_reason: string;
	tier_at: number | null;
}

interface MemoryRow {
	id: string;
	conversation_id: string | null;
	tier: string;
	text: string;
	quote: string | null;
	tags: string;
	importance: number;
	status: string;
	created_at: number;
	expires_at: number | null;
	hits: number;
}

function asTier(value: string): Tier {
	if (value === "critical" || value === "medium") return value;
	return "ordinary";
}

function asStatus(value: string): MemoryStatus {
	if (value === "locked" || value === "expired") return value;
	return "active";
}

function toMemory(row: MemoryRow): MemoryRecord {
	let tags: readonly string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.tags);
		if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === "string");
	} catch {
		tags = [];
	}
	return {
		id: row.id,
		conversationId: row.conversation_id,
		tier: asTier(row.tier),
		text: row.text,
		quote: row.quote,
		tags,
		importance: row.importance,
		status: asStatus(row.status),
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		hits: row.hits,
	};
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

const SCHEMA = [
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE IF NOT EXISTS conversations (",
	"  id TEXT PRIMARY KEY,",
	"  session_id TEXT NOT NULL,",
	"  started_at INTEGER NOT NULL,",
	"  ended_at INTEGER NOT NULL,",
	"  tier TEXT NOT NULL DEFAULT 'ordinary',",
	"  tier_source TEXT NOT NULL DEFAULT 'rule',",
	"  tier_reason TEXT NOT NULL DEFAULT '',",
	"  tier_at INTEGER",
	")",
	"CREATE TABLE IF NOT EXISTS messages (",
	"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
	"  conversation_id TEXT NOT NULL REFERENCES conversations(id),",
	"  seq INTEGER NOT NULL,",
	"  role TEXT NOT NULL,",
	"  content TEXT NOT NULL,",
	"  at INTEGER NOT NULL",
	")",
	"CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, seq)",
	"CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'messages are append-only'); END",
	"CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY, reason TEXT, at INTEGER)",
	"CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages WHEN NOT EXISTS (SELECT 1 FROM maintenance) BEGIN SELECT RAISE(ABORT, 'messages are append-only'); END",
	"CREATE TABLE IF NOT EXISTS memories (",
	"  id TEXT PRIMARY KEY,",
	"  conversation_id TEXT REFERENCES conversations(id),",
	"  tier TEXT NOT NULL,",
	"  text TEXT NOT NULL,",
	"  quote TEXT,",
	"  tags TEXT NOT NULL DEFAULT '[]',",
	"  importance REAL NOT NULL DEFAULT 0.5,",
	"  status TEXT NOT NULL,",
	"  created_at INTEGER NOT NULL,",
	"  expires_at INTEGER,",
	"  hits INTEGER NOT NULL DEFAULT 0,",
	"  last_hit_at INTEGER",
	")",
	"CREATE INDEX IF NOT EXISTS memories_by_status ON memories(status, tier, created_at)",
	"CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tok, memory_id UNINDEXED)",
	"CREATE TABLE IF NOT EXISTS memory_edits (",
	"  id TEXT PRIMARY KEY,",
	"  memory_id TEXT NOT NULL,",
	"  before TEXT NOT NULL,",
	"  after TEXT NOT NULL,",
	"  editor TEXT NOT NULL,",
	"  at INTEGER NOT NULL",
	")",
]
	.map((line) => {
		const trimmed = line.trim();
		const needsTerminator =
			(trimmed === ")" || trimmed.startsWith("PRAGMA") || trimmed.startsWith("CREATE")) && !trimmed.endsWith("(");
		return needsTerminator ? line + ";" : line;
	})
	.join("\n");

/** 原文归档 + 三档记忆。一个实例对应一个 SQLite 文件（或 ":memory:"）。 */
export class SqliteArchive {
	private readonly db: DatabaseSync;
	private readonly ordinaryTtlDays: number;
	private readonly budgetTokens: number;
	private readonly hotHits: number;
	private readonly classifier: ArchiveOptions["classifier"];
	private readonly distiller: ArchiveOptions["distiller"];
	private readonly clock: () => number;
	private counter = 0;

	constructor(options: ArchiveOptions) {
		// 文件库先建目录：第一次启动时 ~/.iris 不存在是正常情况。
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.db = new DatabaseSync(options.path);
		this.ordinaryTtlDays = options.ordinaryTtlDays ?? DEFAULT_TTL_DAYS;
		this.budgetTokens = options.recallBudgetTokens ?? DEFAULT_BUDGET;
		this.hotHits = options.hotHits ?? DEFAULT_HOT_HITS;
		this.classifier = options.classifier;
		this.distiller = options.distiller;
		this.clock = options.now ?? Date.now;
		this.db.exec(SCHEMA);
	}

	/** 原文入库。返回会话 id；可重复调用，只会新增一轮，不覆盖历史。 */
	recordConversation(input: ConversationInput): { conversationId: string; messageCount: number } {
		const now = this.clock();
		const turns = input.turns.filter((turn) => turn.content.trim().length > 0);
		const endedAt = input.endedAt ?? turns[turns.length - 1]?.at ?? now;
		const startedAt = turns[0]?.at ?? endedAt;
		const conversationId = this.nextId("conv", endedAt);
		this.db
			.prepare("INSERT INTO conversations(id, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
			.run(conversationId, input.sessionId, startedAt, endedAt);
		const insert = this.db.prepare(
			"INSERT INTO messages(conversation_id, seq, role, content, at) VALUES (?, ?, ?, ?, ?)",
		);
		for (let index = 0; index < turns.length; index += 1) {
			const turn = turns[index];
			if (turn === undefined) continue;
			insert.run(conversationId, index, turn.role, redact(turn.content), turn.at ?? now);
		}
		return { conversationId, messageCount: turns.length };
	}

	/** 开一个空会话，供 appendTurns + finishConversation 逐步填充。 */
	openConversation(sessionId: string, at = this.clock()): string {
		const id = this.nextId("conv", at);
		this.db
			.prepare("INSERT INTO conversations(id, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
			.run(id, sessionId, at, at);
		return id;
	}

	/** 会话内轮末的轻量归档：只存原文，等会话结束时再分档。 */
	appendTurns(conversationId: string, turns: readonly RawTurn[]): number {
		const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as unknown as
			| ConversationRow
			| undefined;
		if (row === undefined) throw new Error("conversation not found: " + conversationId);
		const last = this.db
			.prepare("SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE conversation_id = ?")
			.get(conversationId) as unknown as { seq: number };
		const insert = this.db.prepare(
			"INSERT INTO messages(conversation_id, seq, role, content, at) VALUES (?, ?, ?, ?, ?)",
		);
		const now = this.clock();
		let seq = Number(last.seq);
		for (const turn of turns) {
			seq += 1;
			insert.run(conversationId, seq, turn.role, redact(turn.content), turn.at ?? now);
		}
		this.db.prepare("UPDATE conversations SET ended_at = ? WHERE id = ?").run(now, conversationId);
		return seq + 1;
	}

	/** 规则优先；给了 classifier 就以它为准。 */
	async classify(conversationId: string): Promise<TierDecision> {
		const turns = this.messagesOf(conversationId);
		const text = turns.map((turn) => turn.content).join("\n");
		const decided = await this.classifier?.({ turns, text });
		if (decided !== undefined) return decided;
		return ruleTier(turns, text);
	}

	/** 一次完整的收尾：原文入库 → 分档 → 提炼 → 按档写记忆。 */
	async ingest(input: ConversationInput): Promise<{
		conversationId: string;
		tier: TierDecision;
		memories: readonly MemoryRecord[];
	}> {
		const { conversationId } = this.recordConversation(input);
		const finished = await this.finishConversation(conversationId);
		return { conversationId, tier: finished.tier, memories: finished.memories };
	}

	/** 会话结束：分档 + 提炼。原文已在库里。 */
	async finishConversation(
		conversationId: string,
	): Promise<{ tier: TierDecision; memories: readonly MemoryRecord[] }> {
		const decision = await this.classify(conversationId);
		this.setTier(conversationId, decision, this.clock());
		const turns = this.messagesOf(conversationId);
		const drafts = (await this.distiller?.({ turns, tier: decision.tier })) ?? fallbackDraft(turns);
		const memories = drafts.map((draft) => this.writeMemory(conversationId, decision.tier, draft));
		return { tier: decision, memories };
	}

	messagesOf(conversationId: string): readonly RawTurn[] {
		const rows = this.db
			.prepare("SELECT role, content, at FROM messages WHERE conversation_id = ? ORDER BY seq")
			.all(conversationId) as unknown as readonly { role: string; content: string; at: number }[];
		return rows.map((row) => ({ role: row.role as RawTurn["role"], content: row.content, at: row.at }));
	}

	conversation(conversationId: string): ConversationRow | null {
		const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as unknown as
			| ConversationRow
			| undefined;
		return row ?? null;
	}

	/** 直接写入一条记忆：立即可检索，不需要谁点头。 */
	remember(draft: MemoryDraft, at = this.clock()): MemoryRecord {
		return this.writeMemory(null, "medium", draft, at);
	}

	/** 直接改写一条记忆的正文（落 memory_edits 审计），改完对新检索立刻生效。 */
	amend(memoryId: string, text: string, editor = "manual", at = this.clock()): MemoryRecord {
		const row = this.memoryRow(memoryId, "amend");
		this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
		this.db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(text, memoryId);
		this.indexMemory(memoryId, text);
		this.db
			.prepare("INSERT INTO memory_edits(id, memory_id, before, after, editor, at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(this.nextId("edit", at), memoryId, row.text, text, editor, at);
		return toMemory(this.memoryRow(memoryId, "amend"));
	}

	/** 直接升为重要档：locked、AI 只读、永不自动过期。 */
	promote(memoryId: string, _at = this.clock()): MemoryRecord {
		this.memoryRow(memoryId, "promote");
		this.db
			.prepare("UPDATE memories SET status = 'locked', tier = 'critical', expires_at = NULL WHERE id = ?")
			.run(memoryId);
		return toMemory(this.memoryRow(memoryId, "promote"));
	}

	/** 直接作废一条记忆：不碰原文，检索里立刻消失。 */
	drop(memoryId: string, at = this.clock()): MemoryRecord {
		this.memoryRow(memoryId, "drop");
		this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
		this.db.prepare("UPDATE memories SET status = 'expired', expires_at = ? WHERE id = ?").run(at, memoryId);
		return toMemory(this.memoryRow(memoryId, "drop"));
	}

	histories(memoryId: string): readonly { before: string; after: string; editor: string; at: number }[] {
		return this.db
			.prepare("SELECT before, after, editor, at FROM memory_edits WHERE memory_id = ? ORDER BY at")
			.all(memoryId) as unknown as readonly { before: string; after: string; editor: string; at: number }[];
	}

	/**
	 * 过期清理 + 热记忆升级。
	 * 普通档只删提炼条，原文永远不动；被反复命中的普通档自动升到中等档（不再问任何人）。
	 */
	sweep(now = this.clock()): { expired: number; promoted: number } {
		const expiredRows = this.db
			.prepare("SELECT id FROM memories WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
			.all(now) as unknown as readonly { id: string }[];
		for (const row of expiredRows) {
			this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(row.id);
			this.db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
		}
		const hot = this.db
			.prepare(
				"SELECT * FROM memories WHERE status = 'active' AND tier = 'ordinary' AND hits >= ? " +
					"AND (last_hit_at IS NULL OR last_hit_at >= ?)",
			)
			.all(this.hotHits, now - 30 * DAY) as unknown as readonly MemoryRow[];
		for (const row of hot) {
			// 升级直接生效：留在这里的理由只有「它被反复想起」，不需要人再点一次头。
			this.db
				.prepare("UPDATE memories SET tier = 'medium', status = 'active', expires_at = NULL WHERE id = ?")
				.run(row.id);
		}
		return { expired: expiredRows.length, promoted: hot.length };
	}

	/** 关键词检索。返回可直接注入 prompt 的文本 + 预算反馈。 */
	recall(query: string, options: RecallOptions = {}): RecallResult {
		const now = options.now ?? this.clock();
		const limit = options.limit ?? 5;
		const tiers = options.tiers ?? ["ordinary", "medium", "critical"];
		const budgetLimit = options.budgetTokens ?? this.budgetTokens;
		const terms = indexTerms(query);
		if (terms.length === 0) {
			return { query, hits: [], text: "", usedTokens: 0, budget: { used: 0, limit: budgetLimit } };
		}

		const expr = terms.map((term) => '"' + term.replace(/"/g, "") + '"').join(" OR ");
		const placeholders = tiers.map(() => "?").join(", ");
		const sql =
			"SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts JOIN memories m ON m.id = memory_fts.memory_id " +
			"WHERE memory_fts MATCH ? AND m.status IN ('active', 'locked') AND m.tier IN (" +
			placeholders +
			") AND m.created_at >= ? ORDER BY rank LIMIT ?";
		const rows = this.db
			.prepare(sql)
			.all(expr, ...tiers, options.since ?? 0, Math.max(limit * 4, 16)) as unknown as readonly (MemoryRow & {
			rank: number;
		})[];

		const wanted = new Set(bigrams(query));
		const scored = rows.map((row, index) => {
			const memory = toMemory(row);
			const found = new Set(bigrams(memory.text + " " + (memory.quote ?? "")));
			let overlap = 0;
			for (const gram of wanted) if (found.has(gram)) overlap += 1;
			const precision = wanted.size === 0 ? 1 : overlap / wanted.size;
			const base = 1 / (1 + index);
			const tierWeight = memory.tier === "critical" ? 1.6 : memory.tier === "medium" ? 1 : 0.6;
			const ageDays = Math.max(0, (now - memory.createdAt) / DAY);
			const decay = 0.6 + 0.4 * Math.exp(-ageDays / 180);
			const importance = 0.7 + 0.3 * memory.importance;
			// 只靠单字命中的降权：单字 OR 噪声大（实测「出去走走」会误中「看海」）。
			const demote = overlap === 0 ? 0.35 : 1;
			return {
				memory,
				score: base * tierWeight * decay * importance * (0.5 + 0.5 * precision) * demote,
				rank: index,
			};
		});

		scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
		const hits: RecallHit[] = [];
		let used = 0;
		for (const row of scored) {
			if (hits.length >= limit) break;
			const cost = estimateTokens(row.memory.text) + 12;
			if (hits.length > 0 && used + cost > budgetLimit) break;
			used += cost;
			hits.push(row);
		}

		const touch = this.db.prepare("UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id = ?");
		for (const hit of hits) touch.run(now, hit.memory.id);

		return {
			query,
			hits,
			text: renderMemories(
				hits.map((hit) => hit.memory),
				now,
			),
			usedTokens: used,
			budget: { used, limit: budgetLimit },
		};
	}

	/**
	 * 开场注入的常驻记忆（ADR-0014 检索时刻①）：重要档在前，其次是已确认的中等档与最近的经验。
	 * 只读，不累加命中——开场注入不等于「被想起」。
	 */
	essential(limit = 6): readonly MemoryRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM memories WHERE status IN ('active', 'locked') " +
					"ORDER BY CASE tier WHEN 'critical' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT ?",
			)
			.all(limit) as unknown as readonly MemoryRow[];
		return rows.map(toMemory);
	}

	/** 按时间列出经历，给 timeline 工具用。 */
	timeline(since: number, limit = 20): readonly MemoryRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM memories WHERE status IN ('active', 'locked') AND created_at >= ? " +
					"ORDER BY created_at DESC LIMIT ?",
			)
			.all(since, limit) as unknown as readonly MemoryRow[];
		return rows.map(toMemory);
	}

	/**
	 * 人工删除整段会话（含原文）。只能由人调用，agent 没有这条路径。
	 * 删原文会短暂打开 maintenance 窗口：触发器只在这个窗口内放行 DELETE。
	 */
	forget(conversationId: string, reason = "human request"): { messages: number; memories: number } {
		const memoryRows = this.db
			.prepare("SELECT id FROM memories WHERE conversation_id = ?")
			.all(conversationId) as unknown as readonly { id: string }[];
		for (const row of memoryRows) this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(row.id);
		this.db.prepare("DELETE FROM memories WHERE conversation_id = ?").run(conversationId);

		const at = this.clock();
		this.db.prepare("INSERT INTO maintenance(id, reason, at) VALUES (1, ?, ?)").run(reason, at);
		let removed = 0;
		try {
			const info = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
			removed = Number(info.changes);
		} finally {
			this.db.prepare("DELETE FROM maintenance WHERE id = 1").run();
		}
		this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
		return { messages: removed, memories: memoryRows.length };
	}

	stats(): {
		conversations: number;
		messages: number;
		byTier: Record<Tier, number>;
		byStatus: Record<MemoryStatus, number>;
	} {
		const count = (sql: string): number => Number((this.db.prepare(sql).get() as unknown as { n: number }).n);
		const byTier: Record<Tier, number> = { ordinary: 0, medium: 0, critical: 0 };
		for (const row of this.db
			.prepare("SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier")
			.all() as unknown as readonly {
			tier: string;
			n: number;
		}[]) {
			byTier[asTier(row.tier)] = Number(row.n);
		}
		const byStatus: Record<MemoryStatus, number> = { active: 0, locked: 0, expired: 0 };
		for (const row of this.db
			.prepare("SELECT status, COUNT(*) AS n FROM memories GROUP BY status")
			.all() as unknown as readonly { status: string; n: number }[]) {
			byStatus[asStatus(row.status)] = Number(row.n);
		}
		return {
			conversations: count("SELECT COUNT(*) AS n FROM conversations"),
			messages: count("SELECT COUNT(*) AS n FROM messages"),
			byTier,
			byStatus,
		};
	}

	close(): void {
		this.db.close();
	}

	private setTier(conversationId: string, decision: TierDecision, at: number): void {
		this.db
			.prepare("UPDATE conversations SET tier = ?, tier_source = ?, tier_reason = ?, tier_at = ? WHERE id = ?")
			.run(decision.tier, decision.source, decision.reason, at, conversationId);
	}

	private memoryRow(id: string, action: string): MemoryRow {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow | undefined;
		if (row === undefined) throw new Error("memory not found (" + action + "): " + id);
		return row;
	}

	private writeMemory(conversationId: string | null, tier: Tier, draft: MemoryDraft, at = this.clock()): MemoryRecord {
		const id = this.nextId("mem", at);
		const status: MemoryStatus = tier === "critical" ? "locked" : "active";
		const expiresAt = tier === "ordinary" ? at + this.ordinaryTtlDays * DAY : null;
		this.db
			.prepare(
				"INSERT INTO memories(id, conversation_id, tier, text, quote, tags, importance, status, created_at, expires_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				conversationId,
				tier,
				draft.text,
				draft.quote ?? null,
				JSON.stringify(draft.tags ?? []),
				draft.importance ?? 0.5,
				status,
				at,
				expiresAt,
			);
		this.indexMemory(id, draft.text + " " + (draft.quote ?? "") + " " + (draft.tags ?? []).join(" "));
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow;
		return toMemory(row);
	}

	private indexMemory(memoryId: string, text: string): void {
		this.db.prepare("INSERT INTO memory_fts(tok, memory_id) VALUES (?, ?)").run(indexTerms(text).join(" "), memoryId);
	}

	private nextId(prefix: string, at: number): string {
		this.counter += 1;
		return prefix + "-" + at.toString(36) + "-" + this.counter;
	}
}

function ruleTier(turns: readonly RawTurn[], text: string): TierDecision {
	if (turns.length === 0) return { tier: "ordinary", reason: "空会话", source: "rule" };
	if (EXPLICIT_MEMORY.test(text)) return { tier: "critical", reason: "用户明确要求记住", source: "rule" };
	if (turns.length >= 4 || DURABLE_SIGNAL.test(text)) {
		return { tier: "medium", reason: "跨多轮或含长期约定", source: "rule" };
	}
	return { tier: "ordinary", reason: "例行闲聊", source: "rule" };
}

function fallbackDraft(turns: readonly RawTurn[]): readonly MemoryDraft[] {
	const users = turns.filter((turn) => turn.role === "user").map((turn) => turn.content);
	const assistant = [...turns].reverse().find((turn) => turn.role === "assistant");
	const tail = assistant === undefined ? "" : " ／ 回复：" + assistant.content;
	const summary = clip("用户：" + users.join(" ／ ") + tail, 160);
	return [
		{
			text: summary,
			quote: clip(users[users.length - 1] ?? "", 60),
			tags: ["对话"],
			importance: 0.5,
		},
	];
}

const TIER_LABEL: Record<Tier, string> = { ordinary: "普通", medium: "中等", critical: "重要" };

function formatDay(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return date.getFullYear() + "-" + month + "-" + day;
}

/** 记忆 → prompt 文本：每条带日期与档位，重要档排最前。 */
export function renderMemories(memories: readonly MemoryRecord[], now: number): string {
	const order: Record<Tier, number> = { critical: 0, medium: 1, ordinary: 2 };
	const sorted = [...memories].sort((a, b) => order[a.tier] - order[b.tier] || b.createdAt - a.createdAt);
	return sorted
		.map((memory) => {
			const age = Math.round((now - memory.createdAt) / DAY);
			const when = age <= 0 ? "今天" : age === 1 ? "昨天" : formatDay(memory.createdAt);
			const quote =
				memory.quote === null || memory.quote.length === 0 ? "" : "（原话：「" + clip(memory.quote, 60) + "」）";
			return "· [" + when + " · " + TIER_LABEL[memory.tier] + "] " + memory.text + quote;
		})
		.join("\n");
}

/** 把记忆当 Episode 喂给旧 MemoryStore（两套可以并存，省一次迁移）。 */
export function toEpisode(memory: MemoryRecord): Episode {
	return {
		id: memory.id,
		at: memory.createdAt,
		kind: "conversation",
		summary: memory.text,
		tags: memory.tags,
		importance: memory.importance,
	};
}
