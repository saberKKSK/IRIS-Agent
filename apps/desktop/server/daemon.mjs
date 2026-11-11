import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createSession,
	defaultArchivePath,
	defaultGrantsPath,
	defaultShellAllowPath,
	defaultWriteGrantsPath,
	FileGuard,
	fileTools,
	ShellGuard,
	SqliteArchive,
	screenTools,
	shellTools,
	webTools,
	WriteGuard,
	writeTools,
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

// —— 等他点头（ADR-0045）。
// 文件 / 写 / 命令这三套的安全模型一直是「问她要不要放开」（files.ts 的 approve 回调）：
// REPL 里有终端能问人，壳里没有——问题不能落在没人看的地方。这里把那个回调焊在窗口上：
// 这一轮挂起，广播一张卡片，他点「就这次 / 以后都放开 / 不给」再回来。
// 超时一律当「不给」：没人看着的时候默认不放行。
const ASK_TIMEOUT_MS = 120_000;
const asks = new Map();
let askSeq = 0;
/** 同时只让一张卡片出现在屏幕上（工具会并行问，两张叠一起没法点）。 */
let askQueue = Promise.resolve();

function askWindow(payload) {
	const run = askQueue.then(
		() =>
			new Promise((resolve) => {
				const id = "ask-" + String(++askSeq);
				const timer = setTimeout(() => {
					asks.delete(id);
					broadcast({ type: "ask", id, phase: "timeout" });
					console.log("[daemon] ask timeout " + id);
					resolve("no");
				}, ASK_TIMEOUT_MS);
				asks.set(id, (choice) => {
					clearTimeout(timer);
					asks.delete(id);
					resolve(choice);
				});
				broadcast({ type: "ask", id, phase: "ask", ...payload });
				console.log("[daemon] ask " + id + " " + payload.title);
			}),
	);
	askQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

const FILE_VERB = { list: "列一下文件夹", search: "在里面翻找内容", read: "读里面的文件" };

const fileGuard = new FileGuard({
	grantsFile: defaultGrantsPath(),
	approve: async (request) => {
		const choice = await askWindow({
			title: "她想" + (FILE_VERB[request.action] ?? "看点什么"),
			detail: request.grant,
			...(request.reason === undefined ? {} : { why: request.reason }),
			options: [
				{ key: "yes", label: "就这次" },
				{ key: "always", label: "以后这个文件夹都给她看" },
				{ key: "no", label: "不给" },
			],
		});
		if (choice === "always") {
			fileGuard.allow(request.root, { persist: true });
			return true;
		}
		return choice === "yes";
	},
});

const WRITE_VERB = { write: "写个文件", append: "往后加内容", mkdir: "建个文件夹", move: "改名或搬家" };

const writeGuard = new WriteGuard({
	grantsFile: defaultWriteGrantsPath(),
	approve: async (request) => {
		const choice = await askWindow({
			title: "她想在里面" + (WRITE_VERB[request.action] ?? "动东西"),
			detail: request.grant,
			...(request.reason === undefined ? {} : { why: request.reason }),
			options: [
				{ key: "yes", label: "就这次" },
				{ key: "always", label: "以后这个文件夹都放给她写" },
				{ key: "no", label: "不给" },
			],
		});
		if (choice === "always") {
			writeGuard.allow(request.root, { persist: true });
			return true;
		}
		return choice === "yes";
	},
});

const shellGuard = new ShellGuard({
	grants: () => writeGuard.grants,
	allowFile: defaultShellAllowPath(),
	approve: async (request) => {
		const choice = await askWindow({
			title: "她想跑一条命令",
			detail: request.command,
			...(request.cwd === undefined || request.cwd === null ? {} : { where: request.cwd }),
			options: [
				{ key: "yes", label: "就这次" },
				{ key: "always", label: "以后 " + request.head + " 这类都放给她" },
				{ key: "no", label: "不跑" },
			],
		});
		if (choice === "always") {
			shellGuard.remember(request.head);
			return true;
		}
		return choice === "yes";
	},
});

// —— 她的心情（ADR-0043 在页面里算，ADR-0044 在这里转成一句话）。
// 页面每 2 秒报一次 (愉悦, 兴奋, 脸, 这张脸挂了多久)；内核每轮现问一次，贴在对方
// 那句话末尾。写进 system prompt 会废掉 prefix cache，而且心情一直在变。
const MOOD_FACE_WORDS = {
	blush: "脸上发热，有点不好意思",
	heart_eyes: "高兴得眼睛发亮",
	smug_eyes: "有点得意，嘴角压不住",
	"swirl_eyes": "脑子乱，有点转不动",
	cold_sweat: "有点尴尬，脸上挂不住",
	dark_face: "心里压着火，脸色不好看",
	tears: "想哭，喉咙发紧",
	distressed_eyes: "快绷不住了",
};
let moodState = null;

/** @returns {string | null} null = 这一刻没什么好说的（平静，或者页面早就没报了）。 */
function moodLine() {
	if (moodState === null) return null;
	if (Date.now() - moodState.at > 90_000) return null;
	const peak = Math.max(Math.abs(moodState.valence), Math.abs(moodState.arousal));
	if (peak < 0.12) return null;
	const word =
		MOOD_FACE_WORDS[moodState.face ?? ""] ??
		(moodState.valence > 0.15 ? "心情不错" : moodState.valence < -0.15 ? "兴致不高" : "心里有点动静");
	const age = Number.isFinite(moodState.held) ? moodState.held : 0;
	const tail = age < 4 ? "，刚起来" : age < 12 ? "，还有点余温" : "，正在慢慢落回去";
	return word + tail;
}

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
	// 文件 / 写 / 命令（ADR-0045）：三本账分开记，问人的地方是窗口里那张卡片，不是终端。
	tools: [
		...webTools(),
		...screenTools(),
		...fileTools({ guard: fileGuard }),
		...writeTools({ guard: writeGuard, reads: fileGuard }),
		...shellTools({ guard: shellGuard }),
	],
	// 她手边到底有哪些文件夹，写进 prompt——不然她会拿「桌面」两个字去猜路径。
	lookRoots: [...new Set([...fileGuard.roots, ...fileGuard.storedGrants])],
	writeRoots: [...writeGuard.grants],
	shellRoots: [...shellGuard.grants],
	mood: moodLine,
});

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
				asking: asks.size,
				mood: moodLine(),
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

	// 他点了卡片：yes 就这次 / always 以后都放开 / no 不给。超时那条路在 askWindow 里。
	if (path === "/answer" && req.method === "POST") {
		void readBody(req).then((body) => {
			const id = typeof body.id === "string" ? body.id : "";
			const choice = body.choice === "always" ? "always" : body.choice === "yes" ? "yes" : "no";
			const resolve = asks.get(id);
			if (resolve === undefined) {
				res.statusCode = 410;
				res.end("gone");
				return;
			}
			res.statusCode = 204;
			res.end();
			broadcast({ type: "ask", id, phase: "done", choice });
			console.log("[daemon] answer " + id + " " + choice);
			resolve(choice);
		});
		return;
	}

	// 页面报心情（ADR-0044）：它算 VAD，这里只负责转成一句人话，每轮贴在那句话末尾。
	if (path === "/mood" && req.method === "POST") {
		void readBody(req).then((body) => {
			const valence = Number(body.valence);
			const arousal = Number(body.arousal);
			if (!Number.isFinite(valence) || !Number.isFinite(arousal)) {
				res.statusCode = 400;
				res.end("bad mood");
				return;
			}
			moodState = {
				valence: Math.max(-1, Math.min(1, valence)),
				arousal: Math.max(-1, Math.min(1, arousal)),
				face: typeof body.face === "string" ? body.face : null,
				held: Number(body.held),
				at: Date.now(),
			};
			res.statusCode = 204;
			res.end();
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
