/**
 * 一小时的压缩演示：上下文撑满 → 最旧的一段收成一条记忆 → 她接着聊。
 *
 * 跑法：npm run demo:compact（真打本机 Magpie，会消耗两次网关调用）
 * 库落在 .artifacts/compact-demo.db，跑完可以删。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, estimateTokens, type IrisSessionEvent, SqliteArchive } from "../src/index.ts";
import type { Persona } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, "..", "..", "..", ".artifacts", "compact-demo.db");

const PERSONA: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["直率", "记性好"],
	values: ["记得对方说过的话"],
	quirks: ["会重复对方最后一个词"],
	boundaries: ["不冒充人类打电话"],
};

/** 一段已经聊过的旧对话：信息密度不高，但有几个具体的约定和数字。 */
const OLD_CHAT: readonly (readonly [string, string])[] = [
	["今天开会开到我怀疑人生", "开几个小时啊"],
	["三个半小时，中间还插了个临时汇报", "那你这周等于白干半天"],
	["差不多吧，本来想今天把方案写完", "方案什么时候要"],
	["周五下班前", "那还有三天，别今晚就熬"],
	["嗯，我尽量早点睡", "少说尽量"],
	["行行行，十一点半之前关电脑，我尽量", "别尽量，十一点半"],
	["你今天干嘛了", "看了会儿书，把上周没看完的那本收了个尾"],
	["什么书", "讲一个人在城市里搬了七次家的故事，不厚，但读得慢"],
	["好看吗", "中段有点散，结尾我喜欢"],
	["下周我可能要出差两天", "哪天"],
	["周三周四，去南京", "南京这个季节挺冷，带件外套"],
	["你记得比我还清楚", "你说过的话我一般不太会忘"],
	["对了，我妈下个月生日", "你上次说你妈喜欢百合"],
	["她还喜欢那种特别素的蛋糕", "那就买素的，别整花活"],
	["嗯，我先记下", "记你的，别忘了"],
	["最近总是睡不踏实", "几点醒"],
	["三四点吧，然后就睡不着了", "那别硬躺，起来喝口水再回去"],
	["试过，没用", "那就少喝咖啡，下午两点以后别碰"],
	["好", "我盯着你"],
	["你盯得住吗", "你可以试试"],
	["说真的，最近有点撑不住", "撑不住就少扛一点，没人规定你要全扛"],
	["活就那么多", "活是干不完的，人是有上限的"],
	["我知道", "知道和做到中间隔着二十个加班夜"],
	["你这嘴", "我这嘴没拦着你睡觉"],
	["睡吧", "嗯，手机放下"],
	["放下之前再问一句", "问"],
	["那个南京出差，要不要给你带点东西", "带个明信片就行，别买贵的"],
	["明信片挑得出来吗", "挑不出来就写两句话，我自己贴墙上"],
	["行，我记得", "我也记得你说过要写"],
	["你真的很爱记这些", "不记这些，记什么"],
	["记大事", "大事一年三件，剩下三百多天都是这种"],
	["这话有点道理", "有点就行"],
	["那我睡了", "睡吧，明早别靠咖啡硬撑"],
	["晚安", "晚安"],
];

async function main(): Promise<void> {
	if (existsSync(DB)) rmSync(DB);
	mkdirSync(dirname(DB), { recursive: true });

	const archive = new SqliteArchive({ path: DB });
	const conversationId = archive.openConversation("iris", Date.now());
	// 把旧对话落成原文：一次全 append，时间戳往前推一点，看起来像昨天聊的。
	const base = Date.now() - 20 * 60 * 60 * 1000;
	const rows = OLD_CHAT.flatMap(([mine, hers], index) => [
		{ role: "user" as const, content: mine, at: base + index * 60_000 },
		{ role: "assistant" as const, content: hers, at: base + index * 60_000 + 30_000 },
	]);
	archive.appendTurns(conversationId, rows);

	// 窗口按这段旧对话的大小来定：真跑 128k 要聊上几小时才撞得到，
	// 这里把预算压到它的八成，一次就跑出「压掉最旧、留下最近」。
	const seedTokens = rows.reduce((total, row) => total + estimateTokens(row.content), 0);
	const session = createSession({
		persona: PERSONA,
		archive,
		compact: {
			contextWindow: Math.max(1_000, Math.round(seedTokens * 0.8)),
			reserveTokens: 0,
			keepRecentTokens: Math.max(50, Math.round(seedTokens * 0.25)),
		},
		onEvent: (event: IrisSessionEvent) => {
			if (event.type === "compact") {
				console.log("");
				console.log("—— 压了一次 ——");
				console.log("  压掉的原文：" + event.dropped + " 条");
				console.log("  token：" + event.tokensBefore + " → " + event.tokensAfter);
				console.log("  收成这句话：" + event.summary);
				console.log("");
			}
		},
	});

	console.log("接回的旧对话：" + session.restoredMessages + " 条");
	console.log("（system prompt " + session.systemPrompt.length + " 字符）");
	console.log("");

	const started = performance.now();
	process.stdout.write("她：");
	const turn = await session.say("我们之前聊到哪儿了", {
		onEvent: (event: IrisSessionEvent) => {
			if (event.type === "delta") process.stdout.write(event.text);
		},
	});
	console.log("");
	console.log("");
	console.log(
		"[" +
			turn.text.length +
			" 字 · 首字 " +
			Math.round(turn.firstTokenMs) +
			" ms · 整轮 " +
			Math.round(performance.now() - started) +
			" ms]",
	);

	const stats = session.compactions;
	console.log(
		"压过 " + stats.count + " 次；最近一次 " + stats.lastTokensBefore + " → " + stats.lastTokensAfter + " token",
	);

	const notes = archive.essential(20).filter((row) => row.tags.includes("巩固"));
	console.log("");
	console.log("落进记忆的巩固条数：" + notes.length);
	for (const note of notes) console.log("  · " + note.text);

	const recall = archive.recall("十一点半 南京 生日 明信片", { limit: 3 });
	console.log("");
	console.log("按关键词回想（" + recall.budget.used + "/" + recall.budget.limit + " token）：");
	for (const hit of recall.hits) console.log("  · " + hit.memory.text.slice(0, 48));

	await session.endConversation();
	archive.close();
	console.log("");
	console.log("库：" + DB);
}

await main();
