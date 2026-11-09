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
	InMemoryMemoryStore,
	IrisSessionError,
	magpieModel,
	magpieStreamFn,
	SqliteArchive,
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
