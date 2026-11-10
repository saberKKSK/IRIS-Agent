import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createSession,
	defaultArchivePath,
	SqliteArchive,
	screenTools,
	webTools,
} from "../../../packages/iris-core/src/index.ts";

/**
 * 桌面壳的脑子：把 iris-core 的 IrisSession 挂在一个本地 HTTP 上。
 * 渲染进程（Live2D 那个页面）只管画和收字幕，一个字都不会自己编。
 *
 * 通道刻意不用 WebSocket：SSE 收流 + fetch 发话，零依赖，浏览器/WebView2/任何壳都通用。
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const CORE = resolve(here, "../../../packages/iris-core");
const PORT = Number(process.env.IRIS_DESKTOP_PORT ?? 5274);
const MODEL_DIR = process.env.IRIS_LIVE2D_DIR ?? "C:/IRIS Agent/assets/live2d/大肥鱼/DeepSeek";

const MIME = {
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".moc3": "application/octet-stream",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".txt": "text/plain; charset=utf-8",
	".vbridger": "application/octet-stream",
};

const doc = readFileSync(join(CORE, "personas", "senjougahara.md"), "utf8");
const archive = new SqliteArchive({ path: process.env.IRIS_ARCHIVE ?? defaultArchivePath() });

const persona = {
	id: "senjougahara",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "senjougahara-zh", pace: "normal", register: "偏低、偏干、带讥诮" },
	traits: [],
	values: [],
	quirks: [],
	boundaries: ["不隐瞒自己是 AI"],
};

const session = createSession({
	persona,
	personaDoc: doc,
	archive,
	state: {
		mood: { label: "calm", valence: 0, arousal: 0.3, updatedAt: Date.now() },
		energy: 0.7,
		activity: "待机",
		speaking: false,
	},
	relationship: { closeness: 0.45, sharedMoments: 0, lastInteractionAt: Date.now() },
	// 壳里的她也得能真的看、真的查（ADR-0042）。工具一进来，system prompt 的能力段
	// 也跟着点亮（session.ts 的 canSearch / canSee 是按 tools 名字算的）。
	// 文件 / 写 / 命令 / 抖音暂不接：它们靠「问她要不要放开」才安全，壳里没有终端问她。
	tools: [...webTools(), ...screenTools()],
});

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();

function broadcast(event) {
	const frame = "data: " + JSON.stringify(event) + "\n\n";
	for (const client of clients) {
		try {
			client.write(frame);
		} catch {
			clients.delete(client);
		}
	}
}

function mapper(event) {
	switch (event.type) {
		case "delta":
			broadcast({ type: "delta", text: event.text });
			return;
		case "expression":
			broadcast({ type: "expression", id: event.id });
			return;
		case "tool_start":
			broadcast({ type: "tool", toolName: event.toolName, phase: "start" });
			return;
		case "tool_end":
			broadcast({ type: "tool", toolName: event.toolName, phase: "end", isError: event.isError });
			return;
		case "turn_end":
			broadcast({
				type: "turn",
				text: event.turn.text,
				expression: event.turn.expression ?? null,
				firstTokenMs: event.turn.firstTokenMs,
				latencyMs: event.turn.latencyMs,
				effort: String(event.turn.effort ?? "none"),
			});
			return;
		case "compact":
			broadcast({ type: "compact", dropped: event.dropped });
			return;
		case "error":
			broadcast({ type: "error", message: event.message });
			return;
		default:
			return;
	}
}

let busy = false;

async function runTurn(kind, text) {
	if (busy) {
		broadcast({ type: "error", message: "上一句还没说完" });
		return;
	}
	busy = true;
	const started = Date.now();
	try {
		if (kind === "speakup") await session.speakUp(text, { onEvent: mapper });
		else await session.say(text, { onEvent: mapper });
	} catch (error) {
		broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
	} finally {
		const elapsed = Date.now() - started;
		console.log("[daemon] " + kind + " " + String(elapsed) + "ms " + JSON.stringify(text.slice(0, 40)));
		busy = false;
	}
}

function cors(res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

function serveModel(res, pathname) {
	const base = resolve(MODEL_DIR);
	let rel;
	try {
		rel = decodeURIComponent(pathname.replace(/^\/live2d/u, ""));
	} catch {
		res.statusCode = 400;
		res.end("bad path");
		return;
	}
	const full = resolve(base, "." + rel);
	if (full !== base && !full.startsWith(base + sep)) {
		res.statusCode = 403;
		res.end("outside");
		return;
	}
	if (!existsSync(full)) {
		res.statusCode = 404;
		res.end("not found");
		return;
	}
	try {
		const bytes = readFileSync(full);
		res.setHeader("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.end(bytes);
	} catch {
		res.statusCode = 500;
		res.end("read failed");
	}
}

const server = createServer((req, res) => {
	cors(res);
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname;

	if (req.method === "OPTIONS") {
		res.statusCode = 204;
		res.end();
		return;
	}

	if (path === "/health") {
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.end(
			JSON.stringify({
				ok: true,
				model: session.model,
				conversation: session.conversation,
				restored: session.restoredMessages,
				busy,
				archive: process.env.IRIS_ARCHIVE ?? defaultArchivePath(),
			}),
		);
		return;
	}

	if (path === "/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write("retry: 1500\n\n");
		res.write(
			"data: " +
				JSON.stringify({ type: "hello", model: session.model, conversation: session.conversation }) +
				"\n\n",
		);
		clients.add(res);
		req.on("close", () => {
			clients.delete(res);
		});
		return;
	}

	if (path === "/say" && req.method === "POST") {
		void readBody(req).then((body) => {
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (text.length === 0) {
				res.statusCode = 400;
				res.end("empty");
				return;
			}
			res.statusCode = 202;
			res.end("queued");
			void runTurn("say", text);
		});
		return;
	}

	if (path === "/speakup" && req.method === "POST") {
		void readBody(req).then((body) => {
			const hint = typeof body.hint === "string" ? body.hint : "";
			res.statusCode = 202;
			res.end("queued");
			void runTurn("speakup", hint);
		});
		return;
	}

	if (path.startsWith("/live2d/")) {
		serveModel(res, path);
		return;
	}

	res.statusCode = 404;
	res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log("[daemon] http://127.0.0.1:" + String(PORT) + " model=" + session.model);
	console.log("[daemon] archive=" + (process.env.IRIS_ARCHIVE ?? defaultArchivePath()));
});

process.on("SIGINT", () => {
	server.close();
	process.exit(0);
});
