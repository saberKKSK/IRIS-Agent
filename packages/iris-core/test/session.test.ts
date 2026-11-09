/**
 * 会话层测试：用假的 StreamFn 驱动 pi 的 Agent，验证 IRIS 只负责它该负责的那部分。
 * 请求组装、重试、SSE、上下文拼接都是 pi 的事，这里不测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { createSession, InMemoryMemoryStore, IrisSessionError, magpieModel, magpieStreamFn } from "../src/index.ts";
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

	assert.equal(turn.text, "我在。");
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
