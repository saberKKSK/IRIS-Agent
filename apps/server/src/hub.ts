/**
 * 每个联系人一套会话：一张人设卡、一个头像、一个 SQLite 记忆库、一个 IrisSession（ADR-0048 / ADR-0049）。
 *
 * 一个用户可以有好几个联系人，磁盘上是 `users/<用户 id>/contacts/<联系人 id>/{card.json, avatar, last.json, iris.db}`。
 * 隔离靠的是「各开各的库文件」，不是在一张表里加 id：iris-core 的会话 id 写死 "iris"
 * 也没关系，别的库根本没打开。会话懒加载，闲了就收尾（分档 + 提炼记忆）再关库。
 *
 * 这里一个工具都不注册。iris-core 的文件 / 命令 / 屏幕工具动的是跑服务的这台机器，
 * 接给外面的用户等于把服务器交出去。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type CompleteFn,
	completeText,
	createSession,
	type IrisSession,
	llmMemory,
	type ModelReasoningEffort,
	SqliteArchive,
} from "../../../packages/iris-core/src/index.ts";

/** 人设卡：她/他是谁，全由用户自己写。 */
export interface Card {
	name: string;
	/** 角色的人称：他 / 她 / 它。 */
	pronouns: string;
	/** prompt 里拿什么指代用户本人：她 / 他。 */
	userPronoun: string;
	/** 允许括号里写动作和神情（角色扮演常用）。 */
	stageDirections: boolean;
	/** 人设正文，原样进 system prompt。 */
	doc: string;
}

/** 列表里那一行的预览：最后一句是谁说的、说了什么。 */
export interface Last {
	role: "user" | "assistant";
	content: string;
	at: number;
}

/** 联系人列表里的一项。 */
export interface Contact extends Card {
	id: string;
	/** 头像的版本号（文件修改时间），没传过头像就是 null。客户端拿它当缓存键。 */
	avatar: number | null;
	last: Last | null;
}

const PRONOUN = /^[\p{L}\p{N}]{1,4}$/u;
const MAX_DOC = 8_000;
/** 一个人最多建几个联系人：每个都是一个库文件，得有个上限。 */
export const MAX_CONTACTS = 20;
/** 联系人 id 的形状。路由拿它校验路径段，所以它同时是防目录穿越的那道闸。 */
export const CONTACT_ID = /^[0-9a-f]{16}$/;

/** 校验客户端发来的卡。返回字符串就是拒绝的理由。 */
export function parseCard(body: Record<string, unknown>): Card | string {
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length === 0 || name.length > 20 || /[\r\n]/.test(name)) return "名字要 1 到 20 个字，不能换行";
	const pronouns = typeof body.pronouns === "string" ? body.pronouns.trim() : "";
	const userPronoun = typeof body.userPronoun === "string" ? body.userPronoun.trim() : "";
	// 这两个词会被拼进 prompt 模板的几十处，只收几个字的纯文字。
	if (!PRONOUN.test(pronouns) || !PRONOUN.test(userPronoun)) return "人称只能是 1 到 4 个字";
	const doc = typeof body.doc === "string" ? body.doc.trim() : "";
	if (doc.length === 0 || doc.length > MAX_DOC) return "人设正文要 1 到 " + String(MAX_DOC) + " 个字";
	return { name, pronouns, userPronoun, stageDirections: body.stageDirections === true, doc };
}

/** 认头像的格式：只收 JPEG / PNG / WebP（看文件头，不信客户端说的类型）。SVG 能带脚本，不收。 */
export function imageType(bytes: Buffer): string | null {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (bytes.length > 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
		return "image/webp";
	}
	return null;
}

/** 往哪个上游发请求。字段缺省就落到 iris-core 的默认值（本机 Magpie）。 */
export interface Upstream {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
}

export interface HubOptions {
	dataDir: string;
	/** 平台自己的 key，没带 key 的用户走这里。 */
	platform: Upstream;
	/** 用户自带 key 时用的地址和模型（key 是用户的）。 */
	byok: Upstream;
	/** 上下文涨到多少 token 开始把旧的收成记忆。iris-core 默认 128k，平台付费压不起。 */
	contextTokens: number;
	idleMs: number;
	effort?: ModelReasoningEffort;
	/** 测试缝：替掉对话模型。 */
	streamFn?: StreamFn;
	/** 测试缝：替掉压缩与记忆提炼用的那次补全。 */
	complete?: CompleteFn;
	now?: () => number;
}

export interface Live {
	session: IrisSession;
	archive: SqliteArchive;
	/** 这一句还没说完：同一个联系人同时只跑一轮。 */
	busy: boolean;
	lastUsed: number;
}

export class Hub {
	private readonly options: HubOptions;
	private readonly clock: () => number;
	/** 开着的会话，键是 `用户 id/联系人 id`。 */
	private readonly lives = new Map<string, Live>();
	/** 正在收尾的会话。收尾要调模型，期间不能再开同一个库。 */
	private readonly closing = new Map<string, Promise<void>>();

	constructor(options: HubOptions) {
		this.options = options;
		this.clock = options.now ?? Date.now;
	}

	private root(userId: string): string {
		return join(this.options.dataDir, "users", userId, "contacts");
	}

	private dir(userId: string, contactId: string): string {
		return join(this.root(userId), contactId);
	}

	cardOf(userId: string, contactId: string): Card | null {
		const file = join(this.dir(userId, contactId), "card.json");
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8")) as Card;
	}

	/** 这个用户的全部联系人，最近聊过的在前；没聊过的按建卡时间排。 */
	contacts(userId: string): Contact[] {
		if (!existsSync(this.root(userId))) return [];
		const rows: { contact: Contact; order: number }[] = [];
		for (const id of readdirSync(this.root(userId))) {
			const card = CONTACT_ID.test(id) ? this.cardOf(userId, id) : null;
			if (card === null) continue;
			const dir = this.dir(userId, id);
			const lastFile = join(dir, "last.json");
			const last = existsSync(lastFile) ? (JSON.parse(readFileSync(lastFile, "utf8")) as Last) : null;
			const avatarFile = join(dir, "avatar");
			const avatar = existsSync(avatarFile) ? Math.floor(statSync(avatarFile).mtimeMs) : null;
			rows.push({
				contact: { id, ...card, avatar, last },
				order: last?.at ?? statSync(join(dir, "card.json")).birthtimeMs,
			});
		}
		return rows.sort((a, b) => b.order - a.order).map((row) => row.contact);
	}

	/** 新建一个联系人，返回 id；到上限了返回 null。 */
	createContact(userId: string, card: Card): string | null {
		if (this.contacts(userId).length >= MAX_CONTACTS) return null;
		const id = randomBytes(8).toString("hex");
		mkdirSync(this.dir(userId, id), { recursive: true });
		writeFileSync(join(this.dir(userId, id), "card.json"), JSON.stringify(card, null, "\t"));
		return id;
	}

	/** 换卡：存盘，丢掉内存里的会话。下一句用新卡重建，历史从库里接回。 */
	async saveCard(userId: string, contactId: string, card: Card): Promise<void> {
		writeFileSync(join(this.dir(userId, contactId), "card.json"), JSON.stringify(card, null, "\t"));
		await this.close(userId, contactId);
	}

	/** 删掉一个联系人：卡、头像、全部聊天原文和记忆一起没，找不回来。 */
	async removeContact(userId: string, contactId: string): Promise<void> {
		// 先关库再删目录：Windows 上开着的 SQLite 文件删不掉。
		await this.close(userId, contactId, false);
		rmSync(this.dir(userId, contactId), { recursive: true, force: true });
	}

	saveAvatar(userId: string, contactId: string, bytes: Buffer): void {
		writeFileSync(join(this.dir(userId, contactId), "avatar"), bytes);
	}

	avatarOf(userId: string, contactId: string): Buffer | null {
		const file = join(this.dir(userId, contactId), "avatar");
		return existsSync(file) ? readFileSync(file) : null;
	}

	/** 记下列表预览用的最后一句。 */
	noteLast(userId: string, contactId: string, last: Last): void {
		const flat = last.content.replace(/\s+/g, " ").trim();
		writeFileSync(
			join(this.dir(userId, contactId), "last.json"),
			JSON.stringify({ ...last, content: flat.length > 60 ? flat.slice(0, 59) + "…" : flat }),
		);
	}

	isBusy(userId: string, contactId: string): boolean {
		return this.lives.get(userId + "/" + contactId)?.busy === true;
	}

	/** 这个用户有没有哪个联系人正在说话。 */
	anyBusy(userId: string): boolean {
		for (const [key, live] of this.lives) if (live.busy && key.startsWith(userId + "/")) return true;
		return false;
	}

	/** 拿这个联系人的会话，没有就建。key 不为 null 就是用户自带的。 */
	async open(userId: string, contactId: string, card: Card, key: string | null): Promise<Live> {
		const id = userId + "/" + contactId;
		await this.closing.get(id);
		const existing = this.lives.get(id);
		if (existing !== undefined) return existing;

		const upstream: Upstream = key === null ? this.options.platform : { ...this.options.byok, apiKey: key };
		const complete: CompleteFn =
			this.options.complete ??
			((prompt, call) => completeText(prompt, { ...upstream, system: call.system, timeoutMs: 30_000 }));
		const archive = new SqliteArchive({
			path: join(this.dir(userId, contactId), "iris.db"),
			...llmMemory({ complete, speaker: card.name }),
		});
		const now = this.clock();
		const session = createSession({
			persona: {
				id: "card",
				name: card.name,
				pronouns: card.pronouns,
				languages: ["中文"],
				voice: { ttsVoice: "", pace: "normal", register: "" },
				traits: [],
				values: [],
				quirks: [],
				// 不让她主动出戏，但对方认真问起时不撒谎。
				boundaries: ["对方认真问你是不是 AI，照实说是"],
			},
			personaDoc: card.doc,
			userPronoun: card.userPronoun,
			stageDirections: card.stageDirections,
			// 纯文字端没有脸可画，不教她写 <脸红>。
			expressions: false,
			archive,
			recallPerTurn: 3,
			// 关系阶段没落库。来的人多半带着一段已有的关系，默认按「亲密」那一档的语气；具体怎么相处卡里写了算。
			relationship: {
				closeness: 0.8,
				sharedMoments: Math.floor(archive.stats().messages / 2),
				lastInteractionAt: now,
			},
			compact: { contextWindow: this.options.contextTokens, complete },
			...upstream,
			...(this.options.effort === undefined ? {} : { reasoningEffort: this.options.effort }),
			...(this.options.streamFn === undefined ? {} : { streamFn: this.options.streamFn }),
		});
		const live: Live = { session, archive, busy: false, lastUsed: now };
		this.lives.set(id, live);
		return live;
	}

	/**
	 * 收尾并关库：把还没提炼的原文分档、提炼成记忆。没开着就什么都不做。
	 * `distill` 为 false 时只关库不提炼（联系人马上要被删，提炼出来也是白花一次调用）。
	 */
	async close(userId: string, contactId: string, distill = true): Promise<void> {
		const id = userId + "/" + contactId;
		const live = this.lives.get(id);
		if (live === undefined) return;
		this.lives.delete(id);
		const done = (async () => {
			try {
				// 没有新话就不收尾：finishConversation 没东西可提炼时会拿整段对话再问一次模型，白花一次调用。
				const conversation = live.session.conversation;
				if (distill && conversation !== null && live.archive.pendingTurns(conversation).length > 0) {
					await live.session.endConversation();
				}
			} catch (error) {
				// 提炼失败不丢东西：原文在库里，游标没动，下次收尾接着提炼。
				console.error("[hub] 收尾失败 " + id, error);
			} finally {
				live.archive.close();
				this.closing.delete(id);
			}
		})();
		this.closing.set(id, done);
		await done;
	}

	/** 关掉这个用户所有开着的会话（换 key 之后要重建）。 */
	async closeUser(userId: string): Promise<void> {
		for (const id of [...this.lives.keys()]) {
			if (id.startsWith(userId + "/")) await this.close(userId, id.slice(userId.length + 1));
		}
	}

	/** 把闲太久的会话收掉。 */
	async sweep(): Promise<void> {
		const now = this.clock();
		for (const [id, live] of [...this.lives]) {
			if (live.busy || now - live.lastUsed <= this.options.idleMs) continue;
			const cut = id.indexOf("/");
			await this.close(id.slice(0, cut), id.slice(cut + 1));
		}
	}

	async closeAll(): Promise<void> {
		for (const id of [...this.lives.keys()]) {
			const cut = id.indexOf("/");
			await this.close(id.slice(0, cut), id.slice(cut + 1));
		}
	}
}
