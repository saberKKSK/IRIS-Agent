/**
 * 会话层测试：用假的 StreamFn 驱动 pi 的 Agent，验证 IRIS 只负责它该负责的那部分。
 * 请求组装、重试、SSE、上下文拼接都是 pi 的事，这里不测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import {
	createSession,
	dmNudge,
	InMemoryMemoryStore,
	IrisSessionError,
	looksLikeDm,
	looksLikeLookup,
	looksLikePromiseAgreement,
	lookupNudge,
	magpieModel,
	magpieStreamFn,
	promiseNudge,
	SqliteArchive,
	stripNudgeText,
	webTools,
} from "../src/index.ts";
import type { Persona } from "../src/types.ts";

const PERSONA: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["好奇", "直率"],
	values: ["不装", "记得对方说过的话"],
	quirks: ["会重复对方最后一个词"],
	boundaries: ["不冒充人类打电话"],
};

function draft(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "magpie",
		model: "deepseek/deepseek-flash",
		usage: {
			input: 12,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function textOf(message: AgentMessage): string {
	if (message.role === "system") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	if (message.role === "assistant") {
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

/** 按脚本回话；每轮的 provider 上下文都记录下来，方便断言 pi 真的带着历史。 */
function scripted(replies: readonly string[], seen?: (messages: readonly AgentMessage[]) => void): StreamFn {
	let call = 0;
	return (_model, context) => {
		seen?.(context.messages);
		const reply = replies[call] ?? "";
		call += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = draft();
			const block = message.content[0];
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			for (const char of reply) {
				if (block?.type === "text") block.text += char;
				stream.push({ type: "text_delta", contentIndex: 0, delta: char, partial: message });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

function failing(reason: string): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "error",
				reason: "error",
				error: { ...draft(), content: [], stopReason: "error", errorMessage: reason },
			});
		});
		return stream;
	};
}

test("一轮对话：人格 prompt 进 pi，回复写回记忆", async () => {
	const memory = new InMemoryMemoryStore();
	memory.append({
		id: "e1",
		at: 0,
		kind: "sightseeing",
		summary: "阴天的海边，风很大",
		tags: ["海"],
		importance: 0.8,
	});
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		memory,
		relationship: { closeness: 0.55, sharedMoments: 1, lastInteractionAt: 0 },
		streamFn: scripted(["我在。"], (messages) => seen.push([...messages])),
	});

	const types: string[] = [];
	const deltas: string[] = [];
	const turn = await session.say("今天有点累", {
		onEvent(event) {
			types.push(event.type);
			if (event.type === "delta") deltas.push(event.text);
		},
	});

	// 默认聊天标点：句尾句号被去掉；原始流事件不动，deltas 仍是模型原话
	assert.equal(turn.text, "我在");
	assert.equal(deltas.join(""), "我在。");
	assert.deepEqual(types, ["turn_start", "delta", "delta", "delta", "turn_end"]);
	assert.ok(turn.episode !== null);
	assert.equal(session.relationship.sharedMoments, 2);
	assert.equal(
		memory.recent(5).some((episode) => episode.summary.includes("今天有点累")),
		true,
	);

	const system = seen[0]?.[0];
	assert.equal(system?.role, "system");
	if (system !== undefined) {
		const prompt = textOf(system);
		assert.ok(prompt.includes("伊里斯"));
		assert.ok(prompt.includes("阴天的海边"));
	}
});

test("第二轮带上第一轮：上下文由 pi 的 transcript 管", async () => {
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["嗯。", "好。"], (messages) => seen.push([...messages])),
	});

	await session.say("第一句");
	await session.say("第二句");

	const second = seen[1] ?? [];
	const texts = second.map(textOf);
	assert.ok(texts.some((text) => text.includes("第一句")));
	assert.ok(texts.some((text) => text.includes("嗯。")));
	assert.ok(texts.some((text) => text.includes("第二句")));
	assert.equal(second.filter((message) => message.role === "system").length, 1);
});

test("模型报错：翻成 IrisSessionError，不吞", async () => {
	const session = createSession({ persona: PERSONA, streamFn: failing("网关 500") });
	const errors: string[] = [];
	await assert.rejects(
		() =>
			session.say("在吗", {
				onEvent(event) {
					if (event.type === "error") errors.push(event.message);
				},
			}),
		(error: unknown) => error instanceof IrisSessionError && error.message.includes("网关 500"),
	);
	assert.deepEqual(errors, ["网关 500"]);
});

test("refreshPrompt 换掉 system 消息，历史保留", async () => {
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]) });
	await session.say("第一句");
	const before = session.messages.length;

	session.updateState({ activity: "在写代码" });
	session.refreshPrompt();

	assert.equal(session.messages.length, before);
	assert.equal(session.messages.filter((message) => message.role === "system").length, 1);
	const first = session.messages[0];
	assert.equal(first?.role, "system");
	if (first !== undefined) assert.ok(textOf(first).includes("在写代码"));
});

test("magpieStreamFn 不抛：连不上网关也只在流里报错", async () => {
	const model = magpieModel({ baseUrl: "http://127.0.0.1:1/v1" });
	const stream = await magpieStreamFn()(
		model,
		normalizeContext({ messages: [{ role: "user", content: "在吗", timestamp: 0 }] }),
		{ maxRetries: 0, timeoutMs: 2000 },
	);

	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	const final = await stream.result();

	assert.ok(types.includes("error"));
	assert.equal(final.stopReason, "error");
});

test("归档：一轮对话落进 SQLite，结束时按三档分类", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const session = createSession({ persona: PERSONA, streamFn: scripted(["那就不说。"]), archive });

	await session.say("今天下班有点累，不太想说话");
	assert.equal(archive.stats().messages, 2, "原文应已落库");

	const finished = await session.endConversation();
	assert.ok(finished);
	assert.equal(finished.tier.tier, "ordinary");
	assert.equal(finished.memories.length, 1);

	const found = session.recall("累");
	assert.ok(found);
	assert.ok(found.hits.length >= 1);
	assert.ok(found.text.includes("累"));
});

test("归档：用户明确要求记住 → critical 且 locked", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const session = createSession({ persona: PERSONA, streamFn: scripted(["好，记下了。"]), archive });

	await session.say("记住这个：我对花生过敏");
	const finished = await session.endConversation();
	assert.ok(finished);
	assert.equal(finished.tier.tier, "critical");
	assert.equal(finished.memories[0]?.status, "locked");
	assert.equal(finished.memories[0]?.expiresAt, null);
});

test("没有归档层时 recall / endConversation 返回 null，不抛", async () => {
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]) });
	await session.say("在吗");
	assert.equal(session.recall("在吗"), null);
	assert.equal(await session.endConversation(), null);
});

test("开场注入：库里上次留下的重要记忆进 system prompt", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	await archive.ingest({
		sessionId: "iris",
		turns: [
			{ role: "user", content: "记住这个：我对花生过敏", at: 0 },
			{ role: "assistant", content: "记下了。", at: 1000 },
		],
	});
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive });

	const prompt = session.systemPrompt;
	assert.ok(prompt.includes("你记得的事"));
	assert.ok(prompt.includes("花生"));
	await session.endConversation();
});

test("自我事实：她自己的账进 prompt，附一句「对不上就说对不上」", () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	archive.rememberSelf("mbti-oejts", "第二次做的是 OEJTS 1.2，四维 72 到 78，结论 INTJ");
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive });

	const prompt = session.systemPrompt;
	assert.ok(prompt.includes("关于你自己"));
	assert.ok(prompt.includes("OEJTS 1.2"));
	assert.ok(prompt.includes("对不上就直接说他记错了"));
});

test("重启接回：上次的原文直接进 pi 的 transcript（ADR-0021）", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const first = createSession({ persona: PERSONA, streamFn: scripted(["在。"]), archive });
	await first.say("在吗");
	await first.endConversation();
	assert.equal(first.restoredMessages, 0, "第一个进程没有可接的历史");

	const seen: AgentMessage[][] = [];
	const second = createSession({
		persona: PERSONA,
		streamFn: scripted(["接上了。"], (messages) => seen.push([...messages])),
		archive,
	});
	assert.equal(second.restoredMessages, 2, "一问一答各算一条");
	assert.ok(second.messages.some((message) => textOf(message).includes("在吗")));
	assert.equal(archive.stats().conversations, 1, "复用的是同一条会话，不是又开一条");

	await second.say("还记得我吗");
	assert.ok(
		seen[0]?.some((message) => textOf(message).includes("在吗")),
		"接回来的历史要真的进请求",
	);
	await second.endConversation();
	assert.equal(archive.stats().conversations, 1);
});

test("接回的边界：关掉不接、隔两天也接、按字符预算裁", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	await archive.ingest({
		sessionId: "iris",
		turns: [
			{ role: "user", content: "很久以前说的话", at: Date.now() - 48 * 60 * 60 * 1000 },
			{ role: "assistant", content: "嗯。", at: Date.now() - 48 * 60 * 60 * 1000 + 1000 },
		],
	});

	const off = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive, resumeMessages: 0 });
	assert.equal(off.restoredMessages, 0);
	// 只看原文消息：ingest 同时提炼了记忆，系统提示里仍会提到这件事（那是记忆层的事）
	assert.equal(off.messages.filter((message) => message.role === "user").length, 0);

	// 同一个会话就是同一段对话：隔了两天也接着聊，不分「新的一天」（ADR-0022）
	const resumed = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive });
	assert.equal(resumed.restoredMessages, 2);
	await resumed.endConversation();

	// 关掉复用就新开一条会话
	const fresh = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive, reuseConversation: false });
	assert.equal(fresh.restoredMessages, 2, "新会话是空的，退回跨会话取最近的原文");
	await fresh.endConversation();
	assert.equal(archive.stats().conversations, 2);

	// 预算只留最新的几条（库里有四条：7 + 2 + 12 + 2 字）
	const trimmed = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive, resumeChars: 14 });
	assert.equal(trimmed.restoredMessages, 2, "字符预算只留得下最后一问一答");
	await trimmed.endConversation();
});

test("同一个会话收尾两次：不重复写记忆", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const first = createSession({ persona: PERSONA, streamFn: scripted(["好。"]), archive });
	await first.say("记住这个：我对花生过敏");
	const ended = await first.endConversation();
	assert.equal(ended?.memories.length, 1);

	const second = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive });
	assert.equal(archive.stats().conversations, 1);
	const again = await second.endConversation();
	assert.equal(again?.memories.length, 0, "没有新内容就不该再写记忆");
	assert.equal(archive.stats().byTier.critical, 1, "记忆只写了一条");
});

test("要不要出去查：只认「去查」的口吻，问自己的事不查", () => {
	const yes = [
		"帮我搜一下今天有什么 AI 新闻",
		"你试试随便搜索",
		"帮我查一下今天东京天气怎么样",
		"搜搜看最近的显卡价格",
		"Google the latest release notes",
	];
	for (const text of yes) assert.equal(looksLikeLookup(text), true, text);
	const no = [
		"今天有点累",
		"你记得我上次说的那个吗",
		"我们上次查过这个吧",
		"帮我想个名字",
		"你搜过没有",
		"查一下记忆里有没有花生",
	];
	for (const text of no) assert.equal(looksLikeLookup(text), false, text);
});

test("强制查那句提示：不带日期、能摘干净", () => {
	const nudge = lookupNudge();
	assert.ok(nudge.includes("这一句是新问题"));
	assert.ok(!nudge.includes("2026年"), "日期改由每轮末尾的时间戳给，提示里不再写死");
	const input = "帮我查一下今天东京天气";
	const sent = input + nudge;
	assert.equal(stripNudgeText(sent), input);
	assert.equal(stripNudgeText(input), input, "没有提示就原样返回");
	assert.equal(stripNudgeText("我提过（这一句是新问题）但不在末尾"), "我提过（这一句是新问题）但不在末尾");
});

test("她要出去查：发给模型的那一轮带提示，落库的仍是原话", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const fake = webTools();
	const session = createSession({ persona: PERSONA, streamFn: scripted(["好。"]), archive, tools: fake });
	await session.say("帮我搜一下今天有什么 AI 新闻");

	const users = session.messages.filter((message) => message.role === "user");
	const last = users.at(-1);
	assert.ok(last !== undefined);
	const text =
		typeof last.content === "string"
			? last.content
			: last.content.map((b) => (b.type === "text" ? b.text : "")).join("");
	assert.ok(text.includes("这一句是新问题"), "发出去的那一轮得带上「只查这一句」的提示");

	const stored = archive.recentMessages(2, 0);
	assert.equal(stored[0]?.content, "帮我搜一下今天有什么 AI 新闻", "落库的是原话，不带提示");
	await session.endConversation();
});

test("没工具就不加那句提示", async () => {
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), tools: [] });
	await session.say("帮我搜一下今天有什么 AI 新闻");
	const users = session.messages.filter((message) => message.role === "user");
	const last = users.at(-1);
	const text = typeof last?.content === "string" ? last.content : "";
	assert.ok(!text.includes("这一句是新问题"));
});

test("每轮请求前现读本机时钟：时间贴在对方那句话后面，历史里不留", async () => {
	const seen: string[] = [];
	const at = new Date(2026, 10, 10, 9, 7).getTime();
	const script = scripted(["知道。"]);
	const session = createSession({
		persona: PERSONA,
		clock: () => at,
		streamFn: (model, context, options) => {
			const content = context.messages.at(-1)?.content;
			seen.push(
				typeof content === "string"
					? content
					: (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join(""),
			);
			return script(model, context, options ?? {});
		},
	});
	await session.say("今天几号");
	assert.ok(seen[0]?.includes("2026年11月10日 星期二 09:07"), "模型看到的必须带这一刻的时间");
	assert.ok(seen[0]?.includes("本机时钟"));

	const stored = session.messages.filter((message) => message.role === "user").at(-1);
	const text =
		typeof stored?.content === "string"
			? stored.content
			: (stored?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
	assert.equal(text, "今天几号", "transcript 里不该留时间戳");
});

test("她说「要不我查一下」，对方「嗯」：认得出，且这一轮真去查", async () => {
	assert.equal(looksLikePromiseAgreement("我没瞎说\n要不我查一下？", "嗯"), true);
	assert.equal(looksLikePromiseAgreement("我没瞎说\n要不我查一下？", "嗯嗯，查吧"), true);
	assert.equal(looksLikePromiseAgreement("我没瞎说\n要不我查一下？", "哦"), false);
	assert.equal(looksLikePromiseAgreement("周四，挨过去还有一天", "嗯"), false, "上一句没答应要查就不逼她");
	assert.equal(looksLikePromiseAgreement(null, "嗯"), false);
	assert.ok(promiseNudge().includes("web_search"));

	const seen: string[] = [];
	const script = scripted(["我没瞎说\n要不我查一下？", "我查了，今天是周二"]);
	const session = createSession({
		persona: PERSONA,
		tools: webTools(),
		streamFn: (model, context, options) => {
			const last = context.messages.at(-1);
			const content = last?.content;
			seen.push(
				typeof content === "string"
					? content
					: (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join(""),
			);
			return script(model, context, options ?? {});
		},
	});
	await session.say("今天是周几");
	await session.say("嗯");
	assert.ok(!seen[0]?.includes("上一条答应的事"), "第一轮没答应过什么，不该带提示");
	assert.ok(seen.at(-1)?.includes("上一条答应的事"), "第二轮是同意，得逼她真去查");
	assert.equal(stripNudgeText(seen.at(-1) ?? ""), "嗯", "提示能从历史里摘干净");
});

test("问私信：认得出、加上「用 douyin_im 真看一遍」的提示、历史里摘得掉", () => {
	assert.equal(looksLikeDm("看看谁给我发私信了"), true);
	assert.equal(looksLikeDm("有人给我发消息吗"), true);
	assert.equal(looksLikeDm("今天天气怎么样"), false);
	const nudged = "看看谁给我发私信了" + dmNudge();
	assert.ok(nudged.includes("douyin_im"));
	assert.equal(stripNudgeText(nudged), "看看谁给我发私信了");
});

test("问私信：手上有 douyin_im 时，这一轮会带上「真去看一遍」的提示", async () => {
	const seen: string[] = [];
	const session = createSession({
		persona: PERSONA,
		tools: [
			{
				name: "douyin_im",
				label: "看私信",
				description: "看私信",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "没有新消息" }], details: {} }),
			},
		],
		streamFn: (model, context, options) => {
			const last = context.messages.at(-1);
			const content = last?.content;
			seen.push(
				typeof content === "string"
					? content
					: (content ?? []).map((block) => (block.type === "text" ? block.text : "")).join(""),
			);
			return scripted(["没看到新消息"])(model, context, options ?? {});
		},
	});
	await session.say("看看谁给我发私信了");
	assert.ok(seen[0]?.includes("douyin_im"), "发给模型的那一句要指名用 douyin_im");
	assert.ok(seen[0]?.includes("别猜别编"));
});

test("自动档位：规则说是闲聊就走 none，并且记在 turn 里", async () => {
	const session = createSession({
		persona: PERSONA,
		autoEffort: true,
		streamFn: scripted(["嗯"]),
		resumeMessages: 0,
	});
	const turn = await session.say("在吗");
	assert.equal(turn.effort, "none");
	assert.equal(session.effort?.source, "rule");
});

test("自动档位：要说理的话升到 low", async () => {
	const session = createSession({
		persona: PERSONA,
		autoEffort: true,
		streamFn: scripted(["站不住"]),
		resumeMessages: 0,
	});
	const turn = await session.say("他说我 MBTI 是 62 到 78，跟我自己记的 72 到 78 对不对得上");
	assert.equal(turn.effort, "low");
	assert.equal(session.effort?.source, "rule");
});

test("自动档位：规则拿不准就问分类模型，判断进 turn", async () => {
	let asked = 0;
	const session = createSession({
		persona: PERSONA,
		autoEffort: true,
		effort: {
			allowClassifier: true,
			classifier: async () => {
				asked += 1;
				return { effort: "low", relation: "new", confidence: 0.9 };
			},
		},
		streamFn: scripted(["这样啊"]),
		resumeMessages: 0,
	});
	const turn = await session.say("今天下午去了海边，风很大，后来吃了点东西就回来了");
	assert.equal(asked, 1);
	assert.equal(turn.effort, "low");
	assert.equal(session.effort?.source, "classifier");
});

test("自动档位：要逼工具的那一轮必须落到 none（思考模式下 tool_choice 会 400）", async () => {
	const session = createSession({
		persona: PERSONA,
		autoEffort: true,
		tools: webTools(),
		effort: {
			allowClassifier: true,
			classifier: async () => ({ effort: "high", relation: "new", confidence: 0.99 }),
		},
		streamFn: scripted(["查过了"]),
		resumeMessages: 0,
	});
	const turn = await session.say("帮我搜一下今天有什么 AI 新闻");
	assert.equal(turn.effort, "none");
	assert.match(session.effort?.reason ?? "", /逼工具/);
});

test("自动档位关着：一直是会话默认档 high，也不问模型", async () => {
	let asked = 0;
	const session = createSession({
		persona: PERSONA,
		effort: {
			allowClassifier: true,
			classifier: async () => {
				asked += 1;
				return { effort: "high", relation: "new", confidence: 1 };
			},
		},
		streamFn: scripted(["嗯"]),
		resumeMessages: 0,
	});
	const turn = await session.say("他说我 MBTI 是 62 到 78，跟我自己记的 72 到 78 对不对得上");
	assert.equal(asked, 0);
	assert.equal(turn.effort, "high");
	assert.equal(session.effort, null);
});

test("强制工具那一轮：turn 里记的是 none（那一请求真的关了思考）", async () => {
	const session = createSession({
		persona: PERSONA,
		tools: webTools(),
		streamFn: scripted(["查过了"]),
		resumeMessages: 0,
	});
	const turn = await session.say("帮我搜一下今天有什么 AI 新闻");
	assert.equal(turn.effort, "none");
});

test("主动开口：没人问也能说一句，那句 cue 留在历史里（ADR-0037）", async () => {
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["我在听", "你在跑测试，报错那行我看见了"], (messages) => seen.push([...messages])),
		compact: false,
		resumeMessages: 0,
	});
	await session.say("我先跑个测试");
	const turn = await session.speakUp();
	assert.match(turn.text, /报错/u);
	const last = seen.at(-1)?.at(-1);
	assert.equal(last?.role, "user");
	assert.match(textOf(last as AgentMessage), /你自己开口/u);
	// 没有人问过的那一轮不该被当成对方说的话
	assert.equal(textOf(session.messages.at(-4) as AgentMessage), "我先跑个测试");
});

test("主动开口：她那句照样落库，cue 不进库（ADR-0037 补记）", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["我在听", "你在跑测试，报错那行我看见了"]),
		archive,
		compact: false,
		resumeMessages: 0,
	});
	await session.say("我先跑个测试");
	const turn = await session.speakUp();
	assert.equal(archive.stats().messages, 3, "他一句两行 + 她主动那一句");
	const rows = archive.recentMessages(10, 0);
	assert.equal(rows.at(-1)?.role, "assistant");
	assert.equal(rows.at(-1)?.content, turn.text);
	assert.ok(
		rows.every((row) => !row.content.includes("你自己开口")),
		"cue 是现场，不该进库",
	);
});

test("接回历史：她主动那一句并进上一条 assistant，不出现连着两条", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	await archive.ingest({
		sessionId: "iris",
		turns: [
			{ role: "user", content: "我先跑个测试", at: 0 },
			{ role: "assistant", content: "我在听", at: 1000 },
			{ role: "assistant", content: "报错那行我看见了", at: 2000 },
			{ role: "user", content: "嗯", at: 3000 },
		],
	});
	const session = createSession({ persona: PERSONA, streamFn: scripted(["嗯。"]), archive });
	const messages = session.messages;
	assert.equal(messages.filter((message) => message.role === "assistant").length, 1, "两条 assistant 要并成一条");
	const merged = textOf(messages.find((message) => message.role === "assistant") as AgentMessage);
	assert.match(merged, /我在听/u);
	assert.match(merged, /报错那行我看见了/u);
	assert.equal(messages.at(-1)?.role, "user");
	assert.equal(session.restoredMessages, 3);
});

test("感知层：每轮请求末尾带上他在干什么，session 自己的历史不留（ADR-0037）", async () => {
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["嗯"], (messages) => seen.push([...messages])),
		compact: false,
		resumeMessages: 0,
		perception: () => "他屏幕上是：一个终端，正在跑测试（刚刚）",
	});
	await session.say("在干嘛");
	const last = seen[0]?.at(-1) as AgentMessage;
	assert.match(textOf(last), /一个终端/u);
	assert.match(textOf(last), /正在跑测试/u);
	assert.equal(textOf(session.messages.at(-2) as AgentMessage), "在干嘛");
});

test("没接感知层：一个字都不加", async () => {
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["嗯"], (messages) => seen.push([...messages])),
		compact: false,
		resumeMessages: 0,
	});
	await session.say("在干嘛");
	const last = seen[0]?.at(-1) as AgentMessage;
	assert.doesNotMatch(textOf(last), /他屏幕上是/u);
});

test("心情是活的：每轮末尾附一句，prompt 里不再写死一个数（ADR-0044）", async () => {
	const seen: AgentMessage[][] = [];
	let mood: string | null = "偏高兴、有点兴奋，还在往下落";
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["嗯"], (messages) => seen.push([...messages])),
		compact: false,
		resumeMessages: 0,
		mood: () => mood,
	});
	assert.match(session.systemPrompt, /## 你的心情/u, "接上心情就要教她怎么带着它说话");
	assert.match(session.systemPrompt, /以那句为准/u);
	assert.doesNotMatch(session.systemPrompt, /心情：calm/u, "写死的那个数会跟她真实的心情打架");
	await session.say("在干嘛");
	assert.match(textOf(seen[0]?.at(-1) as AgentMessage), /你现在的心情：偏高兴/u);
	assert.equal(textOf(session.messages.at(-2) as AgentMessage), "在干嘛", "附注不进历史");
	// 平了就闭嘴：每轮都报一句「我很平静」等于噪音。
	mood = null;
	await session.say("好");
	assert.doesNotMatch(textOf(seen[1]?.at(-1) as AgentMessage), /你现在的心情/u);
});

test("没接心情：prompt 里还是写死的那个数，也不附注", async () => {
	const seen: AgentMessage[][] = [];
	const session = createSession({
		persona: PERSONA,
		streamFn: scripted(["嗯"], (messages) => seen.push([...messages])),
		compact: false,
		resumeMessages: 0,
	});
	assert.doesNotMatch(session.systemPrompt, /## 你的心情/u);
	assert.match(session.systemPrompt, /心情：calm/u);
	await session.say("在干嘛");
	assert.doesNotMatch(textOf(seen[0]?.at(-1) as AgentMessage), /你现在的心情/u);
});
