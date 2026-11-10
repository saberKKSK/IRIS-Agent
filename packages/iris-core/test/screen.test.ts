import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSystemPrompt, type PromptContext } from "../src/persona.ts";
import { type CapturedFrame, DEFAULT_SCREEN_PROMPT, type DescribeFn, screenTools } from "../src/screen.ts";
import type { VisionNote } from "../src/vision.ts";

function frame(): CapturedFrame {
	return { path: "C:/tmp/iris-screen/frame.jpg", bytes: 29_000, width: 512, height: 320, ms: 240 };
}

function note(text: string): VisionNote {
	return { text, model: "fake-vision", latencyMs: 8_700, bytes: 29_000, promptTokens: 248, completionTokens: 12 };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

describe("看屏幕（ADR-0036）", () => {
	it("把屏幕上看到的东西原样交回来", async () => {
		const prompts: string[] = [];
		const look = screenTools({
			capture: async () => frame(),
			describe: async (_frame, call) => {
				prompts.push(call?.prompt ?? "");
				return note("他在打游戏，血条剩一半。");
			},
		})[0];
		assert.equal(look.name, "look_at_screen");
		const result = await look.execute("call-1", {});
		assert.equal(result.details?.ok, true);
		assert.equal(result.details?.action, "look");
		assert.equal(result.details?.captureMs, 240);
		assert.equal(result.details?.visionMs, 8_700);
		assert.match(textOf(result), /血条剩一半/u);
		// 缩略图会糊：交回来的话后面得挂着这句提醒
		assert.match(textOf(result), /小字和数字可能看错/u);
		assert.equal(prompts[0], DEFAULT_SCREEN_PROMPT);
	});

	it("他给了问题就照他的问题问，问法自己会收口", async () => {
		const prompts: string[] = [];
		const look = screenTools({
			capture: async () => frame(),
			describe: async (_frame, call) => {
				prompts.push(call?.prompt ?? "");
				return note("报错写着 ECONNREFUSED。");
			},
		})[0];
		await look.execute("call-2", { question: "那行报错写的什么" });
		assert.match(prompts[0], /^那行报错写的什么/u);
		assert.match(prompts[0], /三句以内/u);
	});

	it("偷不到屏幕就说偷不到，不抛", async () => {
		const look = screenTools({
			capture: async () => {
				throw new Error("没抓到屏幕：拒绝访问");
			},
			describe: async () => note("不该走到这里"),
		})[0];
		const result = await look.execute("call-3", {});
		assert.equal(result.isError, true);
		assert.equal(result.details?.ok, false);
		assert.match(textOf(result), /拒绝访问/u);
	});

	it("视觉模型不说话也是一条错误，不是空白回答", async () => {
		const describeFail: DescribeFn = async () => {
			throw new Error("视觉模型什么都没说（这张图可能超出它的能力）");
		};
		const look = screenTools({ capture: async () => frame(), describe: describeFail })[0];
		const result = await look.execute("call-4", {});
		assert.equal(result.isError, true);
		assert.match(textOf(result), /什么都没说/u);
		assert.equal(result.details?.path, "C:/tmp/iris-screen/frame.jpg");
	});

	it("prompt：有这只眼睛才讲看屏幕，没工具一个字不提", () => {
		const base: PromptContext = {
			persona: {
				id: "iris",
				name: "伊里斯",
				pronouns: "她",
				languages: ["中文"],
				voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低" },
				traits: ["好奇"],
				values: ["不装"],
				quirks: [],
				boundaries: [],
			},
			state: {
				mood: { label: "calm", valence: 0, arousal: 0.3, updatedAt: 0 },
				energy: 0.7,
				activity: "待机",
				speaking: false,
			},
			relationship: { closeness: 0.45, sharedMoments: 0, lastInteractionAt: 0 },
			recent: [],
			now: new Date(2026, 10, 10, 11, 0).getTime(),
		};
		assert.doesNotMatch(buildSystemPrompt(base), /你能看屏幕/u);
		const seeing = buildSystemPrompt({ ...base, canSee: true });
		assert.match(seeing, /## 你能看屏幕/u);
		assert.match(seeing, /8 到 18 秒/u);
		assert.match(seeing, /他没提屏幕/u);
	});
});
