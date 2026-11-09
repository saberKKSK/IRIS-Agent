/**
 * 上下文压缩测试（ADR-0023）：涨到窗口边上就把最旧的一段收进记忆。
 * 这里不测 pi 的 transformContext 怎么被调用，只测压缩器本身与会话层的接线。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Consolidation } from "../src/context.ts";
import { createCompactor, createSession, estimateMessagesTokens, plainSummary, SqliteArchive } from "../src/index.ts";
import type { Persona } from "../src/types.ts";

const PERSONA: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["直率"],
	values: ["记得对方说过的话"],
	quirks: ["会重复对方最后一个词"],
	boundaries: ["不冒充人类打电话"],
};

function user(text: string, at = 1_700_000_000_000): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: at } as unknown as AgentMessage;
}

function assistant(text: string, at = 1_700_000_000_000): AgentMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "magpie",
		model: "deepseek/deepseek-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: at,
	};
	return message as unknown as AgentMessage;
}

/** 造一段足够长的聊天：每一轮都是 user + assistant，正文按 id 编号，方便断言哪段被压掉了。 */
function longChat(pairs: number, chars: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < pairs; index += 1) {
		const filler = "这是一段用来把上下文撑长的旧聊天，" + "第" + index + "轮。";
		messages.push(user((filler + "啊".repeat(chars)).slice(0, chars)));
		messages.push(assistant((filler + "嗯".repeat(chars)).slice(0, chars)));
	}
	return messages;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

test("没超预算：原样放行，不叫模型", async () => {
	let calls = 0;
	const compactor = createCompactor({
		contextWindow: 128_000,
		complete: async () => {
			calls += 1;
			return "不该走到这里";
		},
	});
	const messages = longChat(2, 40);
	const result = await compactor.compact(messages);
	assert.equal(result.length, messages.length);
	assert.equal(calls, 0);
	assert.equal(compactor.state.count, 0);
});

test("超预算：最旧的一段收成一条便签，剩下的从他说的话开始", async () => {
	const messages = longChat(12, 300);
	const consolidations: Consolidation[] = [];
	const compactor = createCompactor({
		contextWindow: 1_000,
		reserveTokens: 0,
		keepRecentTokens: 200,
		complete: async () => "他讲了一堆工作上的事，最后说想早点睡。",
		onConsolidate: (result) => {
			consolidations.push(result);
		},
	});
	const before = estimateMessagesTokens(messages);
	const result = await compactor.compact(messages);

	assert.ok(result.length < messages.length);
	const note = textOf(result[0] ?? ({} as AgentMessage));
	assert.match(note, /更早的聊天我记着了/);
	assert.match(note, /想早点睡/);
	assert.equal(result[1]?.role, "user");
	assert.ok(estimateMessagesTokens(result) < before);
	assert.equal(compactor.state.count, 1);
	assert.equal(consolidations.length, 1);
	assert.deepEqual(
		consolidations[0]?.turns.map((turn) => turn.role) === undefined
			? []
			: [...new Set(consolidations[0].turns.map((turn) => turn.role))],
		["user", "assistant"],
	);
});

test("模型挂了：用原文兜底，压缩本身不抛错", async () => {
	const messages = longChat(10, 300);
	const compactor = createCompactor({
		contextWindow: 1_000,
		reserveTokens: 0,
		keepRecentTokens: 100,
		complete: async () => {
			throw new Error("网关没开");
		},
	});
	const result = await compactor.compact(messages);
	const note = textOf(result[0] ?? ({} as AgentMessage));
	assert.match(note, /他：/);
	assert.ok(result.length < messages.length);
});

test("压出来比原文还长：退回原文摘要", async () => {
	const messages = longChat(10, 300);
	const compactor = createCompactor({
		contextWindow: 1_000,
		reserveTokens: 0,
		keepRecentTokens: 100,
		complete: async () => "啰".repeat(9_000),
	});
	const result = await compactor.compact(messages);
	const note = textOf(result[0] ?? ({} as AgentMessage));
	assert.ok(!note.includes("啰啰啰"));
	assert.match(note, /他：/);
});

test("plainSummary：按说话人拼、每条截断、总量封顶", () => {
	const turns = [
		{ role: "user" as const, content: "我".repeat(100), at: 0 },
		{ role: "assistant" as const, content: "好".repeat(20), at: 0 },
	];
	const summary = plainSummary(turns, 200);
	assert.ok(summary.startsWith("他："));
	assert.ok(summary.includes("／") === false);
	assert.ok(summary.length <= 200);
	assert.ok(summary.includes("…"));
});

/** 按脚本回话的假 StreamFn：只够跑完一轮，不关心内容。 */
function scripted(replies: readonly string[], seen?: (messages: readonly AgentMessage[]) => void): StreamFn {
	let call = 0;
	return (_model, context) => {
		seen?.(context.messages);
		const reply = replies[call] ?? "";
		call += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: "openai-completions",
				provider: "magpie",
				model: "deepseek/deepseek-flash",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const block = message.content[0];
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			for (const char of reply) {
				if (block !== undefined && block.type === "text") block.text += char;
				stream.push({ type: "text_delta", contentIndex: 0, delta: char, partial: message });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

test("会话层：压出来的那段落进记忆，三车道收到 compact 事件", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const conversationId = archive.openConversation("iris", 1_700_000_000_000);
	const seed = longChat(12, 300).map((message) => ({
		role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
		content: textOf(message),
		at: 1_700_000_000_000,
	}));
	archive.appendTurns(conversationId, seed);

	const events: string[] = [];
	const session = createSession({
		persona: PERSONA,
		archive,
		streamFn: scripted(["嗯"]),
		compact: {
			contextWindow: 1_000,
			reserveTokens: 0,
			keepRecentTokens: 200,
			complete: async () => "他讲了一堆旧事。",
		},
		onEvent: (event) => events.push(event.type),
	});

	assert.ok(session.restoredMessages > 10);
	await session.say("在吗");
	assert.equal(session.compactions.count, 1);
	assert.ok(events.includes("compact"));
	const notes = archive.essential(20).map((row) => row.text);
	assert.ok(notes.some((text) => text.includes("他讲了一堆旧事")));
	archive.close();
});

test("会话层：compact: false 就完全不压", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	const conversationId = archive.openConversation("iris", 1_700_000_000_000);
	archive.appendTurns(
		conversationId,
		longChat(12, 300).map((message) => ({
			role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
			content: textOf(message),
			at: 1_700_000_000_000,
		})),
	);
	const session = createSession({
		persona: PERSONA,
		archive,
		streamFn: scripted(["嗯"]),
		compact: false,
	});
	await session.say("在吗");
	assert.equal(session.compactions.count, 0);
	archive.close();
});
