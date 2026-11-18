/**
 * 起服务（ADR-0048）：`npm run server`。
 *
 * 必填 IRIS_SECRET（封用户自带 key 的主密钥，至少 16 个字符，换了它已存的 key 全部作废）。
 * 其余都有默认值：
 *   IRIS_PORT / IRIS_HOST            监听地址，默认 127.0.0.1:5280（对外请放在带 HTTPS 的反向代理后面）
 *   IRIS_DATA                        数据目录，默认 ~/.iris/server
 *   IRIS_UPSTREAM_BASE_URL/_MODEL/_KEY  平台上游；不填就是 iris-core 的默认（本机 Magpie）
 *   IRIS_BYOK_BASE_URL/_MODEL        用户自带 key 时走哪，默认 DeepSeek 官方
 *   IRIS_DAILY_TURNS                 没带 key 的用户每天几轮，默认 100
 *   IRIS_CONTEXT_TOKENS              上下文窗口上限，默认 64000（超了把旧的收成记忆）
 *   IRIS_EFFORT                      none | low | high，不填用 iris-core 的默认
 *   IRIS_SECURE_COOKIE=1 / IRIS_TRUST_PROXY=1  上了 HTTPS / 前面有反向代理时打开
 *   IRIS_DEV_PHONE                   开发用：设了就用这个手机号免验证码登录，生产不要设
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";

/** 数字配置：没填或填坏了就用默认值，不能让一个错字把额度变成 NaN（等于不限）。 */
function num(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return process.env[name] !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

const secret = process.env.IRIS_SECRET ?? "";
if (secret.length < 16) {
	console.error("[server] 先设 IRIS_SECRET（至少 16 个字符）。它用来加密用户自带的 API key。");
	process.exit(1);
}

const effort = process.env.IRIS_EFFORT;
const devPhone = process.env.IRIS_DEV_PHONE?.trim() || undefined;
if (devPhone !== undefined && !/^1[3-9]\d{9}$/.test(devPhone)) {
	console.error("[server] IRIS_DEV_PHONE 要是一个手机号，比如 13800138000。");
	process.exit(1);
}
const app = createApp({
	dataDir: process.env.IRIS_DATA ?? join(homedir(), ".iris", "server"),
	secret,
	devPhone,
	platform: {
		baseUrl: process.env.IRIS_UPSTREAM_BASE_URL,
		model: process.env.IRIS_UPSTREAM_MODEL,
		apiKey: process.env.IRIS_UPSTREAM_KEY,
	},
	byok: {
		baseUrl: process.env.IRIS_BYOK_BASE_URL ?? "https://api.deepseek.com/v1",
		model: process.env.IRIS_BYOK_MODEL ?? "deepseek-chat",
	},
	dailyTurns: num("IRIS_DAILY_TURNS", 100),
	contextTokens: num("IRIS_CONTEXT_TOKENS", 64_000),
	idleMs: 30 * 60_000,
	...(effort === "none" || effort === "low" || effort === "high" ? { effort } : {}),
	secureCookie: process.env.IRIS_SECURE_COOKIE === "1",
	trustProxy: process.env.IRIS_TRUST_PROXY === "1",
	// 开发期：验证码打在日志里。能看日志的人就能登任何号——上线前换成短信商。
	sendCode: (phone, code) => console.log("[server] 验证码 " + phone + " → " + code),
});

const port = num("IRIS_PORT", 5280);
const host = process.env.IRIS_HOST ?? "127.0.0.1";
app.server.listen(port, host, () => {
	console.log("[server] http://" + host + ":" + String(port));
	console.log("[server] 验证码目前只打日志，没接短信商");
	if (devPhone !== undefined) console.log("[server] 开发登录已开：" + devPhone + "（免验证码）");
});

process.on("SIGINT", () => {
	// 收尾会把没提炼的对话提炼成记忆，等它做完再退。
	void app.stop().then(() => process.exit(0));
});
