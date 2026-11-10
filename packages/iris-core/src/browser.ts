/**
 * 借用插件那台无头 Chrome（ADR-0028）。
 *
 * 为什么点赞非得走页面：读接口（推荐流、评论）用 a_bogus 签名 + Cookie 就能过，
 * 但写接口（点赞）还要 ticket-guard 的请求头，那套东西只有页面里的 SDK 算得出来。
 * 插件本来就常驻一台无头 Chrome（--headless=new，看不见窗口），这里连它的 CDP
 * 在页面上下文里发请求 —— 签名、ticket-guard、Cookie 全都由页面自己带。
 *
 * 零依赖：Node 24 自带 WebSocket 与 fetch。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { defaultDouyinHome } from "./douyin.ts";

/** 插件会在这段端口里找空闲的（见 lib/chrome.mjs）。 */
const PORT_RANGE = { from: 9334, to: 9373 };

/** 插件的目录（lib/chrome.mjs 在里面）。 */
function pluginDir(home: string): string {
	const fromEnv = process.env.IRIS_DOUYIN_PLUGIN?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	const server = process.env.IRIS_DOUYIN_SERVER?.trim();
	if (server !== undefined && server !== "") return join(server, "..", "..");
	const dshHome = process.env.DSH_HOME?.trim();
	const base = dshHome !== undefined && dshHome !== "" ? dshHome : join(home, "..");
	return join(base, "profiles", "desktop", "node_modules", "dsh-douyin-scroll");
}

async function probe(port: number, timeoutMs = 400): Promise<boolean> {
	try {
		const response = await fetch("http://127.0.0.1:" + String(port) + "/json/version", {
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** 这台机器上有没有已经开着的无头 Chrome；开着就回端口。 */
export async function findChromePort(): Promise<number | null> {
	const probes: Promise<number | null>[] = [];
	for (let port = PORT_RANGE.from; port <= PORT_RANGE.to; port += 1) {
		probes.push(probe(port).then((ok) => (ok ? port : null)));
	}
	const found = await Promise.all(probes);
	return found.find((port): port is number => port !== null) ?? null;
}

export interface ChromeOptions {
	/** 插件家目录，默认 ~/.dsh/douyin-duty。 */
	home?: string;
	/** 起浏览器最多等多久，默认 60 秒。 */
	timeoutMs?: number;
}

/**
 * 拿到一个可用的无头 Chrome 端口：先找现成的，找不到就让插件的 ensureChrome 起一台。
 * 起浏览器这件事交给插件做，是为了跟它用同一个 profile（登录态、指纹都在里面）。
 */
export async function ensureChrome(options: ChromeOptions = {}): Promise<number> {
	const home = options.home ?? defaultDouyinHome();
	const existing = await findChromePort();
	if (existing !== null) return existing;

	const dir = pluginDir(home);
	const entry = join(dir, "lib", "chrome.mjs");
	const script =
		"const m = await import(" +
		JSON.stringify("file:///" + entry.replace(/\\/gu, "/")) +
		"); const r = await m.ensureChrome(); console.log(JSON.stringify(r));";

	const port = await new Promise<number | null>((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: dir,
			env: { ...process.env, DOUYIN_HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(null);
		}, options.timeoutMs ?? 60_000);
		child.stdout.on("data", (chunk: Buffer | string) => {
			out += String(chunk);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const start = out.indexOf("{");
			if (start < 0) {
				resolve(null);
				return;
			}
			try {
				const parsed = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as { port?: number };
				resolve(typeof parsed.port === "number" ? parsed.port : null);
			} catch {
				resolve(null);
			}
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
	if (port === null) throw new Error("起不来无头 Chrome（插件的 ensureChrome 没回端口）");
	return port;
}

interface Target {
	id?: string;
	type?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

async function targets(port: number): Promise<Target[]> {
	const response = await fetch("http://127.0.0.1:" + String(port) + "/json/list", {
		signal: AbortSignal.timeout(3000),
	});
	const list = (await response.json()) as Target[];
	return Array.isArray(list) ? list : [];
}

async function openTab(port: number, url: string): Promise<void> {
	const endpoint = "http://127.0.0.1:" + String(port) + "/json/new?" + encodeURIComponent(url);
	try {
		await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(5000) });
	} catch {
		try {
			await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
		} catch {
			/* 开不了就算了，后面页面检查会报 */
		}
	}
}

export interface EvaluateOptions {
	/** 最多等多久，默认 30 秒。 */
	timeoutMs?: number;
	/** 页面必须是这个域，默认 douyin.com。 */
	host?: string;
	/** 插件家目录，默认 ~/.dsh/douyin-duty。 */
	home?: string;
}

interface Session {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	close(): void;
	readonly closed: Promise<void>;
}

async function connect(target: Target): Promise<Session> {
	const url = target.webSocketDebuggerUrl;
	if (url === undefined) throw new Error("这个标签页没有调试地址");
	const socket = new WebSocket(url);
	let next = 0;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let done: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		done = resolve;
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("连不上调试端口")), 5000);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("调试端口报错"));
		});
	});

	socket.addEventListener("message", (event) => {
		let message: { id?: number; result?: unknown; error?: { message?: string } };
		try {
			message = JSON.parse(String(event.data)) as typeof message;
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const slot = pending.get(message.id);
		if (slot === undefined) return;
		pending.delete(message.id);
		if (message.error !== undefined) slot.reject(new Error(message.error.message ?? "CDP 报错"));
		else slot.resolve(message.result);
	});
	socket.addEventListener("close", () => {
		done();
		for (const slot of pending.values()) slot.reject(new Error("调试连接断了"));
		pending.clear();
	});

	const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
		next += 1;
		const id = next;
		return new Promise<unknown>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	};

	return {
		send,
		close: () => socket.close(),
		closed,
	};
}

/** 在抖音页面的上下文里跑一段表达式（页面自己带签名与登录态）。 */
export async function evaluateOnDouyin<T>(expression: string, options: EvaluateOptions = {}): Promise<T> {
	const host = options.host ?? "douyin.com";
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	const port = await ensureChrome(options.home === undefined ? {} : { home: options.home });
	let page = (await targets(port)).find((target) => target.type === "page" && (target.url ?? "").includes(host));
	if (page === undefined) {
		await openTab(port, "https://www." + host + "/");
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			page = (await targets(port)).find((target) => target.type === "page" && (target.url ?? "").includes(host));
			if (page !== undefined || Date.now() > deadline) break;
		}
	}
	if (page === undefined) throw new Error("没开成抖音页面");

	const session = await connect(page);
	try {
		await session.send("Runtime.enable");
		for (;;) {
			const ready = (await session.send("Runtime.evaluate", {
				expression: "document.readyState",
				returnByValue: true,
			})) as { result?: { value?: unknown } };
			if (ready.result?.value === "complete") break;
			if (Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const evaluated = (await session.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		})) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
		if (evaluated.exceptionDetails !== undefined) {
			throw new Error(evaluated.exceptionDetails.exception?.description?.slice(0, 300) ?? "页面里报错");
		}
		return evaluated.result?.value as T;
	} finally {
		session.close();
	}
}
