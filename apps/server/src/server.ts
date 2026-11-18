/**
 * 多用户服务端的 HTTP 面（ADR-0048）。
 *
 * 登录态两条路都认：浏览器走 HttpOnly cookie，App 走 `Authorization: Bearer`。
 * 说话是一次 POST，响应本身就是 SSE 流（沿用桌面壳「SSE 收流 + fetch 发话」的约定，不上 WebSocket）。
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayStamp } from "../../../packages/iris-core/src/index.ts";
import { Accounts, type User } from "./accounts.ts";
import { type Card, CONTACT_ID, Hub, type HubOptions, imageType, parseCard } from "./hub.ts";

const PHONE = /^1[3-9]\d{9}$/;
const COOKIE = "iris_session";
const COOKIE_MAX_AGE = 30 * 86_400;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4_000;
const CODES_PER_IP_PER_HOUR = 10;
const PAGE = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "public", "index.html"));

export interface AppOptions extends HubOptions {
	/** 封自带 key 的主密钥。 */
	secret: string;
	/** 没带 key 的用户每天能聊几轮。 */
	dailyTurns: number;
	/** 把验证码送到用户手里。开发期打日志，上线换短信商。 */
	sendCode(phone: string, code: string): void | Promise<void>;
	/** cookie 带 Secure（上了 HTTPS 就开）。 */
	secureCookie?: boolean;
	/** 前面有反向代理：客户端 IP 取 X-Forwarded-For 的最后一段。 */
	trustProxy?: boolean;
	/** 开发用：设了就让 `POST /auth/dev` 免验证码换 token。生产不要设。 */
	devPhone?: string;
	/** 账号库路径；不给就放在 dataDir 下。 */
	accountsPath?: string;
}

export interface App {
	server: Server;
	hub: Hub;
	accounts: Accounts;
	stop(): Promise<void>;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status);
		res.end();
		return;
	}
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/** 读 JSON 对象。null = 不是合法的 JSON 对象；"too_large" = 超了上限。 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null | "too_large"> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		// 超了就不再存，但把剩下的读完丢掉：不读完就回 413，对面多半只看到连接被掐断。
		if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
	}
	if (size > MAX_BODY_BYTES) return "too_large";
	// 没带 body 的 POST（比如登出）当空对象。
	if (size === 0) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function tokenOf(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ")) return header.slice(7).trim();
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [name, value] = part.trim().split("=");
		if (name === COOKIE && value !== undefined) return value;
	}
	return null;
}

export function createApp(options: AppOptions): App {
	const now = options.now ?? Date.now;
	const accounts = new Accounts({
		path: options.accountsPath ?? join(options.dataDir, "accounts.db"),
		secret: options.secret,
		now,
	});
	const hub = new Hub(options);
	const cookieTail = "; Path=/; HttpOnly; SameSite=Lax" + (options.secureCookie === true ? "; Secure" : "");
	// shortcut: 发码限流记在内存里，重启清零、多实例各记各的；上多实例时挪进账号库。
	const codeHits = new Map<string, { count: number; resetAt: number }>();

	function clientIp(req: IncomingMessage): string {
		const forwarded = options.trustProxy === true ? req.headers["x-forwarded-for"] : undefined;
		const last = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : undefined;
		return last ?? req.socket.remoteAddress ?? "";
	}

	function userOf(req: IncomingMessage): User | null {
		const token = tokenOf(req);
		return token === null ? null : accounts.userOf(token);
	}

	async function say(user: User, contactId: string, card: Card, text: string, res: ServerResponse): Promise<void> {
		const key = accounts.keyOf(user.id);
		const day = dayStamp(now());
		// 额度按人算，不按联系人算：多建几个角色不该多出几份额度。
		if (key === null && accounts.platformTurns(user.id, day) >= options.dailyTurns) {
			return send(res, 429, { error: "quota" });
		}
		const live = await hub.open(user.id, contactId, card, key);
		if (live.busy) return send(res, 409, { error: "busy" });
		live.busy = true;

		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			"X-Accel-Buffering": "no",
		});
		// 头先发出去：不然要等到第一个字（思考时可能十几秒）客户端才知道这句被接住了。
		res.flushHeaders();
		const write = (event: object): void => {
			res.write("data: " + JSON.stringify(event) + "\n\n");
		};
		// 模型思考时可能十几秒没有字，隔一会儿吐个注释行，免得中间的代理当成死连接掐掉。
		const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
		try {
			// 对面断线不打断这一轮：手机网络说断就断，让她说完落库，重连后从 /history 看得到。
			const turn = await live.session.say(text, {
				onEvent: (event) => {
					if (event.type === "delta") write({ type: "delta", text: event.text });
				},
			});
			accounts.countTurn(user.id, day, key !== null, turn.usage.promptTokens, turn.usage.completionTokens);
			hub.noteLast(user.id, contactId, { role: "assistant", content: turn.text, at: now() });
			write({ type: "turn", text: turn.text });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error("[server] 这一轮失败 " + user.id + " " + detail);
			// 自带 key 的人需要看到上游原话（key 无效、欠费）；平台 key 的报错是我们自己的事，不往外说。
			write({ type: "error", message: key === null ? "对面出了点问题，过一会儿再试" : detail });
		} finally {
			clearInterval(ping);
			live.busy = false;
			live.lastUsed = now();
			res.end();
		}
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const route = (req.method ?? "GET") + " " + url.pathname;

		if (route === "GET /") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
			res.end(PAGE);
			return;
		}

		let body: Record<string, unknown> = {};
		if (req.method !== "GET") {
			// 带 cookie 的写操作只认同源。App 不发 Origin，走 Bearer，不吃这条。
			const origin = req.headers.origin;
			const host = req.headers.host ?? "";
			if (origin !== undefined && origin !== "http://" + host && origin !== "https://" + host) {
				return send(res, 403, { error: "cross_origin" });
			}
			if (req.method !== "DELETE") {
				const parsed = await readJson(req);
				if (parsed === "too_large") return send(res, 413, { error: "too_large" });
				if (parsed === null) return send(res, 400, { error: "bad_json" });
				body = parsed;
			}
		}

		if (route === "POST /auth/code") {
			const phone = typeof body.phone === "string" ? body.phone.trim() : "";
			if (!PHONE.test(phone)) return send(res, 400, { error: "bad_phone" });
			const ip = clientIp(req);
			const seen = codeHits.get(ip);
			const hit = seen !== undefined && seen.resetAt > now() ? seen : { count: 0, resetAt: now() + 3_600_000 };
			if (hit.count >= CODES_PER_IP_PER_HOUR) return send(res, 429, { error: "too_many" });
			if (codeHits.size > 10_000) codeHits.clear();
			codeHits.set(ip, { count: hit.count + 1, resetAt: hit.resetAt });
			const code = accounts.issueCode(phone);
			if (code === null) return send(res, 429, { error: "too_many" });
			await options.sendCode(phone, code);
			return send(res, 204);
		}

		if (route === "POST /auth/login") {
			const phone = typeof body.phone === "string" ? body.phone.trim() : "";
			const code = typeof body.code === "string" ? body.code.trim() : "";
			const result = PHONE.test(phone) ? accounts.login(phone, code) : null;
			if (result === null) return send(res, 401, { error: "bad_code" });
			res.setHeader("Set-Cookie", COOKIE + "=" + result.token + "; Max-Age=" + String(COOKIE_MAX_AGE) + cookieTail);
			return send(res, 200, { token: result.token });
		}

		// 绕验证码只给本机开发用：没配 IRIS_DEV_PHONE 时这个路由不存在（404）。
		if (route === "POST /auth/dev") {
			if (options.devPhone === undefined) return send(res, 404, { error: "not_found" });
			const result = accounts.devLogin(options.devPhone);
			res.setHeader("Set-Cookie", COOKIE + "=" + result.token + "; Max-Age=" + String(COOKIE_MAX_AGE) + cookieTail);
			return send(res, 200, { token: result.token });
		}

		const user = userOf(req);
		if (user === null) return send(res, 401, { error: "unauthorized" });

		switch (route) {
			case "POST /auth/logout": {
				accounts.logout(tokenOf(req) ?? "");
				res.setHeader("Set-Cookie", COOKIE + "=; Max-Age=0" + cookieTail);
				return send(res, 204);
			}
			case "GET /me": {
				const key = accounts.keyOf(user.id);
				return send(res, 200, {
					phone: user.phone.slice(0, 3) + "****" + user.phone.slice(7),
					// key 只回显末 4 位。
					keyTail: key === null ? null : key.slice(-4),
					quota: { used: accounts.platformTurns(user.id, dayStamp(now())), limit: options.dailyTurns },
				});
			}
			case "PUT /key": {
				const key = typeof body.key === "string" ? body.key.trim() : "";
				if (key.length < 8 || key.length > 200 || /\s/.test(key)) return send(res, 400, { error: "bad_key" });
				if (hub.anyBusy(user.id)) return send(res, 409, { error: "busy" });
				accounts.setKey(user.id, key);
				// 会话建的时候就定了走哪个上游，换 key 得重建。
				await hub.closeUser(user.id);
				return send(res, 204);
			}
			case "DELETE /key": {
				if (hub.anyBusy(user.id)) return send(res, 409, { error: "busy" });
				accounts.setKey(user.id, null);
				await hub.closeUser(user.id);
				return send(res, 204);
			}
			case "GET /contacts":
				return send(res, 200, { contacts: hub.contacts(user.id) });
			case "POST /contacts": {
				const card = parseCard(body);
				if (typeof card === "string") return send(res, 400, { error: "bad_card", message: card });
				const id = hub.createContact(user.id, card);
				if (id === null) return send(res, 409, { error: "too_many_contacts" });
				return send(res, 201, { id });
			}
		}

		// 下面都是某一个联系人的事。id 的形状在这里卡死，后面拿它拼目录才安全；
		// 目录又挂在登录用户自己的 id 底下，所以摸不到别人的联系人。
		const match = /^\/contacts\/([^/]+)(\/avatar|\/history|\/say)?$/.exec(url.pathname);
		const contactId = match?.[1] ?? "";
		const card = CONTACT_ID.test(contactId) ? hub.cardOf(user.id, contactId) : null;
		if (card === null) return send(res, 404, { error: "not_found" });

		switch ((req.method ?? "GET") + " " + (match?.[2] ?? "")) {
			case "PUT ": {
				const next = parseCard(body);
				if (typeof next === "string") return send(res, 400, { error: "bad_card", message: next });
				if (hub.isBusy(user.id, contactId)) return send(res, 409, { error: "busy" });
				await hub.saveCard(user.id, contactId, next);
				return send(res, 204);
			}
			case "DELETE ": {
				if (hub.isBusy(user.id, contactId)) return send(res, 409, { error: "busy" });
				await hub.removeContact(user.id, contactId);
				return send(res, 204);
			}
			case "PUT /avatar": {
				// 客户端先缩到 256 像素再传，所以装得进 64 KB 的 JSON；这里只认文件头。
				const raw = typeof body.data === "string" ? body.data : "";
				const bytes = Buffer.from(raw.slice(raw.indexOf(",") + 1), "base64");
				if (imageType(bytes) === null) return send(res, 400, { error: "bad_image" });
				hub.saveAvatar(user.id, contactId, bytes);
				return send(res, 204);
			}
			case "GET /avatar": {
				const bytes = hub.avatarOf(user.id, contactId);
				const type = bytes === null ? null : imageType(bytes);
				if (bytes === null || type === null) return send(res, 404, { error: "not_found" });
				res.writeHead(200, {
					"Content-Type": type,
					"X-Content-Type-Options": "nosniff",
					// 地址里带着版本号（?v=），换了头像地址就变，所以可以放心长缓存。
					"Cache-Control": "private, max-age=31536000, immutable",
				});
				res.end(bytes);
				return;
			}
			case "GET /history": {
				const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
				const live = await hub.open(user.id, contactId, card, accounts.keyOf(user.id));
				return send(res, 200, {
					messages: live.archive.history(50, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER),
				});
			}
			case "POST /say": {
				const text = typeof body.text === "string" ? body.text.trim() : "";
				if (text.length === 0 || text.length > MAX_TEXT_CHARS) return send(res, 400, { error: "bad_text" });
				return say(user, contactId, card, text, res);
			}
			default:
				return send(res, 404, { error: "not_found" });
		}
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			console.error("[server] " + String(req.method) + " " + String(req.url), error);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	const sweeper = setInterval(() => void hub.sweep(), 60_000);
	sweeper.unref();

	return {
		server,
		hub,
		accounts,
		async stop() {
			clearInterval(sweeper);
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await hub.closeAll();
			accounts.close();
		},
	};
}
