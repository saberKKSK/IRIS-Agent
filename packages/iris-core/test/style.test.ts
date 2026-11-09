/**
 * 语料风格测试：切句 → 量档 → 渲染 → 接进会话。
 * 断言只看结构和量出来的数，不看具体措辞（措辞会随语料变）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	analyzeStyle,
	createSession,
	importStyle,
	readCorpus,
	renderStyle,
	SqliteArchive,
	splitUtterances,
	structuredLines,
	summarizeStyle,
	toneFlags,
} from "../src/index.ts";
import type { StyleProfile } from "../src/style.ts";
import type { Persona } from "../src/types.ts";

const CHAT = [
	"# 聊天记录",
	"小鹿：今天下雨了，你带伞没？",
	"阿远：带了。你呢",
	"小鹿：我忘啦，哈哈……反正走过去也就十分钟吧",
	"- 这是列表，不是说话",
	"阿远：那就一起走呗，正好我也没事。",
	"小鹿：行啊～那我在楼下等你",
	"阿远：嗯，别磨蹭。",
].join("\n");

const PERSONA: Persona = {
	id: "iris",
	name: "伊里斯",
	pronouns: "她",
	languages: ["中文"],
	voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
	traits: ["好奇"],
	values: ["记得对方说过的话"],
	quirks: ["会追问细节"],
	boundaries: ["不冒充人类打电话"],
};

test("切句：认名字前缀、跳过标题与列表、剥掉引号", () => {
	const rows = splitUtterances({ name: "chat.txt", text: CHAT });
	assert.ok(rows.length >= 5);
	assert.equal(rows[0]?.speaker, "小鹿");
	assert.equal(rows[0]?.text, "今天下雨了，你带伞没？");
	assert.equal(
		rows.some((row) => row.text.includes("这是列表")),
		false,
	);
	assert.equal(
		rows.some((row) => row.text.startsWith("#")),
		false,
	);

	const only = splitUtterances({ name: "chat.txt", text: CHAT }, { speaker: "阿远" });
	assert.ok(only.length >= 2);
	assert.equal(
		only.every((row) => row.speaker === "阿远"),
		true,
	);
});

test("结构化导出：JSONL 与数组 JSON 都翻成「名字：内容」", () => {
	const lines = structuredLines('{"speaker":"阿远","text":"带了。"}\n{"role":"小鹿","content":"忘啦"}');
	assert.deepEqual(lines, ["阿远：带了。", "小鹿：忘啦"]);

	const array = structuredLines('[{"name":"阿远","message":"嗯"},{"sender":"小鹿","text":"走啦"}]');
	assert.deepEqual(array, ["阿远：嗯", "小鹿：走啦"]);

	assert.deepEqual(structuredLines("这不是 JSON"), []);
});

test("读语料：目录递归，只收文本扩展名", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-style-"));
	try {
		writeFileSync(join(dir, "chat.txt"), CHAT, "utf8");
		writeFileSync(join(dir, "dump.jsonl"), '{"speaker":"阿远","text":"嗯。"}\n', "utf8");
		writeFileSync(join(dir, "logo.png"), "not really a png", "utf8");
		const files = readCorpus([dir]);
		assert.deepEqual(files.map((file) => file.name).sort(), ["chat.txt", "dump.jsonl"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("量档案：句长、语气词、口癖、样本都是数出来的", () => {
	const samples = splitUtterances({ name: "chat.txt", text: CHAT });
	const profile = analyzeStyle(samples, { name: "小鹿", source: "chat.txt", speaker: "小鹿", now: 1000 });
	assert.equal(profile.utterances, samples.length);
	assert.ok(profile.avgChars > 0 && profile.avgChars < 60);
	assert.ok(profile.medianChars <= profile.p90Chars);
	assert.ok(profile.punctuationPer1000.comma > 0);
	assert.ok(profile.particles.some((row) => row.token === "啦" || row.token === "吧" || row.token === "啊"));
	assert.ok(profile.samples.length >= 1);
	assert.equal(profile.importedAt, 1000);
});

test("渲染：空档案不占位，有档案就带样本与「别这样」", () => {
	const empty = analyzeStyle([], { name: "空", source: "" });
	assert.equal(renderStyle(empty), "");

	const profile = analyzeStyle(splitUtterances({ name: "chat.txt", text: CHAT }), {
		name: "小鹿",
		source: "chat.txt",
		speaker: "小鹿",
		summary: "说话短，爱笑，不太解释。",
	});
	const text = renderStyle(profile);
	assert.ok(text.includes("## 说话方式"));
	assert.ok(text.includes("小鹿"));
	assert.ok(text.includes("这个人：说话短"));
	assert.ok(text.includes("原话"));
	assert.ok(text.includes("别这样说话"));
});

test("AI 味：翻案 / 结论冒号 / 起手式 / 三连顿号 / 翻译腔都能逮住，正常口语不误报", () => {
	const kinds = (text: string): string[] => toneFlags(text).map((flag) => flag.kind);

	assert.deepEqual(kinds("这不是运气，而是准备。"), ["flip"]);
	assert.deepEqual(kinds("核心是：你先别急。"), ["colon"]);
	assert.deepEqual(kinds("说白了，就是不想去。"), ["opener"]);
	assert.deepEqual(kinds("猫、狗、鸟都养过"), ["enumeration"]);
	assert.deepEqual(kinds("对于我来说，这事挺难的"), ["translation"]);
	assert.deepEqual(kinds("我带了伞，你呢？"), []);

	const flag = toneFlags("这不是运气，而是准备。")[0];
	assert.ok(flag !== undefined);
	assert.ok(flag.advice.length > 0);
});

test("导入：没有可用句子就报错；给了 summarize 才调模型", async () => {
	await assert.rejects(
		() => importStyle("空", [{ name: "x.txt", text: "# 只有标题\n- 只有列表\n" }]),
		/没有能用的句子/,
	);

	let called = 0;
	const profile = await importStyle("小鹿", [{ name: "chat.txt", text: CHAT }], {
		speaker: "小鹿",
		summarize: true,
		complete: async () => {
			called += 1;
			return "说话短，带笑，会催人。";
		},
	});
	assert.equal(called, 1);
	assert.equal(profile.summary, "说话短，带笑，会催人。");
	assert.ok(renderStyle(profile).includes("这个人：说话短"));

	const failed = await summarizeStyle(profile, {
		complete: async () => {
			throw new Error("网关挂了");
		},
	});
	assert.equal(failed, undefined);
});

test("归档：同名覆盖、生效切换、删除", () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	try {
		const profile = analyzeStyle(splitUtterances({ name: "chat.txt", text: CHAT }), {
			name: "小鹿",
			source: "chat.txt",
			speaker: "小鹿",
			now: 10,
		});
		archive.saveStyle(profile);
		assert.equal(archive.style()?.name, "小鹿");

		const other: StyleProfile = { ...profile, name: "阿远", speaker: "阿远", importedAt: 20 };
		archive.saveStyle(other);
		assert.equal(archive.style()?.name, "阿远");
		assert.equal(archive.styles().length, 2);
		assert.equal(archive.styles()[0]?.active, true);

		archive.activateStyle("小鹿");
		assert.equal(archive.style()?.name, "小鹿");
		assert.equal(archive.removeStyle("小鹿"), true);
		assert.equal(archive.style(), undefined);
	} finally {
		archive.close();
	}
});

function draft(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "magpie",
		model: "deepseek/deepseek-flash",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function scripted(replies: readonly string[], seen: AgentMessage[][]): StreamFn {
	let call = 0;
	return (_model, context) => {
		seen.push([...context.messages]);
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

function textOf(message: AgentMessage): string {
	if (message.role === "system") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

test("会话：库里导入过的语料风格自动进 system prompt", async () => {
	const archive = new SqliteArchive({ path: ":memory:" });
	try {
		const profile = analyzeStyle(splitUtterances({ name: "chat.txt", text: CHAT }), {
			name: "小鹿",
			source: "chat.txt",
			speaker: "小鹿",
		});
		archive.saveStyle(profile);

		const seen: AgentMessage[][] = [];
		const session = createSession({
			persona: PERSONA,
			archive,
			streamFn: scripted(["行啊，楼下等你。"], seen),
		});

		assert.equal(session.style?.name, "小鹿");
		assert.ok(session.systemPrompt.includes("## 说话方式"));

		await session.say("在楼下等你？");
		const system = seen[0]?.[0];
		assert.equal(system?.role, "system");
		const prompt = system === undefined ? "" : textOf(system);
		assert.ok(prompt.includes("照着语料学"));
		assert.ok(prompt.includes("别这样说话"));
	} finally {
		archive.close();
	}
});
