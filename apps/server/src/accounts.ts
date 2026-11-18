/**
 * 账号库：手机号、验证码、登录 token、自带 key、每日用量（ADR-0048）。
 *
 * 所有用户共用这一个 SQLite 文件；聊天原文和记忆不在这里，在每个用户自己的库里（hub.ts）。
 * 三样东西不落明文：验证码与 token 只存 sha256，自带 key 用 AES-256-GCM 封好再存。
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomInt,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CODE_TTL_MS = 5 * 60_000;
const CODE_GAP_MS = 60_000;
const MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  api_key TEXT
);
CREATE TABLE IF NOT EXISTS codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  byok INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, byok)
);
`;

export interface AccountsOptions {
	/** 文件路径，或 ":memory:"。 */
	path: string;
	/** 封自带 key 用的主密钥。换了它，已存的 key 全部作废。 */
	secret: string;
	now?: () => number;
}

export interface User {
	id: string;
	phone: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export class Accounts {
	private readonly db: DatabaseSync;
	private readonly sealKey: Buffer;
	private readonly clock: () => number;

	constructor(options: AccountsOptions) {
		if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
		this.db = new DatabaseSync(options.path);
		this.db.exec(SCHEMA);
		this.sealKey = scryptSync(options.secret, "iris-byok", 32);
		this.clock = options.now ?? Date.now;
	}

	/** 发一个 6 位验证码。同一个号一分钟一条，发太勤返回 null。 */
	issueCode(phone: string): string | null {
		const now = this.clock();
		const last = this.db.prepare("SELECT sent_at FROM codes WHERE phone = ?").get(phone) as unknown as
			| { sent_at: number }
			| undefined;
		if (last !== undefined && now - last.sent_at < CODE_GAP_MS) return null;
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		this.db
			.prepare("INSERT OR REPLACE INTO codes(phone, code_hash, sent_at, attempts) VALUES (?, ?, ?, 0)")
			.run(phone, sha256(phone + ":" + code), now);
		return code;
	}

	/** 验码换 token；没注册过就顺手注册。码不对、过期、错太多次都是 null。 */
	login(phone: string, code: string): { user: User; token: string } | null {
		const now = this.clock();
		const row = this.db
			.prepare("SELECT code_hash, sent_at, attempts FROM codes WHERE phone = ?")
			.get(phone) as unknown as { code_hash: string; sent_at: number; attempts: number } | undefined;
		if (row === undefined) return null;
		if (now - row.sent_at > CODE_TTL_MS || row.attempts >= MAX_ATTEMPTS) {
			this.db.prepare("DELETE FROM codes WHERE phone = ?").run(phone);
			return null;
		}
		if (!timingSafeEqual(Buffer.from(row.code_hash, "hex"), Buffer.from(sha256(phone + ":" + code), "hex"))) {
			this.db.prepare("UPDATE codes SET attempts = attempts + 1 WHERE phone = ?").run(phone);
			return null;
		}
		this.db.prepare("DELETE FROM codes WHERE phone = ?").run(phone);
		return this.session(phone);
	}

	/** 开发用：跳过验证码直接换 token。只在服务端显式配置了 IRIS_DEV_PHONE 时才会被路由暴露。 */
	devLogin(phone: string): { user: User; token: string } {
		return this.session(phone);
	}

	/** 注册（如果没有）并签发一个 30 天 token。 */
	private session(phone: string): { user: User; token: string } {
		const now = this.clock();
		// 用户 id 是随机的：它会当目录名用，不能让手机号出现在磁盘路径里。
		this.db
			.prepare("INSERT OR IGNORE INTO users(id, phone, created_at) VALUES (?, ?, ?)")
			.run(randomBytes(12).toString("hex"), phone, now);
		const user = this.db.prepare("SELECT id, phone FROM users WHERE phone = ?").get(phone) as unknown as User;
		const token = randomBytes(32).toString("base64url");
		this.db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(now);
		this.db
			.prepare("INSERT INTO tokens(hash, user_id, expires_at) VALUES (?, ?, ?)")
			.run(sha256(token), user.id, now + TOKEN_TTL_MS);
		return { user: { id: user.id, phone: user.phone }, token };
	}

	userOf(token: string): User | null {
		const row = this.db
			.prepare(
				"SELECT u.id, u.phone FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.expires_at > ?",
			)
			.get(sha256(token), this.clock()) as unknown as User | undefined;
		return row === undefined ? null : { id: row.id, phone: row.phone };
	}

	logout(token: string): void {
		this.db.prepare("DELETE FROM tokens WHERE hash = ?").run(sha256(token));
	}

	/** 存（或清掉）用户自带的上游 key。落库的是 iv + tag + 密文，绑定用户 id。 */
	setKey(userId: string, key: string | null): void {
		let sealed: string | null = null;
		if (key !== null) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
			cipher.setAAD(Buffer.from(userId));
			const body = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
			sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
		}
		this.db.prepare("UPDATE users SET api_key = ? WHERE id = ?").run(sealed, userId);
	}

	/** 解不开（主密钥换过、库被动过）就当没有 key：退回平台额度，比整轮 500 强。 */
	keyOf(userId: string): string | null {
		const row = this.db.prepare("SELECT api_key FROM users WHERE id = ?").get(userId) as unknown as
			| { api_key: string | null }
			| undefined;
		if (row === undefined || row.api_key === null) return null;
		try {
			const raw = Buffer.from(row.api_key, "base64");
			const decipher = createDecipheriv("aes-256-gcm", this.sealKey, raw.subarray(0, 12));
			decipher.setAAD(Buffer.from(userId));
			decipher.setAuthTag(raw.subarray(12, 28));
			return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
		} catch {
			return null;
		}
	}

	/** 记一轮用量。自带 key 的也记，只是不拿它卡额度。 */
	countTurn(userId: string, day: string, byok: boolean, promptTokens: number, completionTokens: number): void {
		this.db
			.prepare(
				"INSERT INTO usage(user_id, day, byok, turns, prompt_tokens, completion_tokens) VALUES (?, ?, ?, 1, ?, ?) " +
					"ON CONFLICT(user_id, day, byok) DO UPDATE SET turns = turns + 1, " +
					"prompt_tokens = prompt_tokens + excluded.prompt_tokens, " +
					"completion_tokens = completion_tokens + excluded.completion_tokens",
			)
			.run(userId, day, byok ? 1 : 0, promptTokens, completionTokens);
	}

	/** 这一天用平台 key 聊了几轮。 */
	platformTurns(userId: string, day: string): number {
		const row = this.db
			.prepare("SELECT turns FROM usage WHERE user_id = ? AND day = ? AND byok = 0")
			.get(userId, day) as unknown as { turns: number } | undefined;
		return row?.turns ?? 0;
	}

	close(): void {
		this.db.close();
	}
}
