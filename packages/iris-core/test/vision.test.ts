import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { imageFrame } from "../src/session.ts";
import type { VisionChunk, VisionNote, VisionStream, VisionStreamFn, VisionStreamResult } from "../src/vision.ts";
import { describeImage, loadImage, MAX_IMAGE_BYTES, mimeOf } from "../src/vision.ts";

const dir = mkdtempSync(join(tmpdir(), "iris-vision-"));

/** 造一张假图：内容不重要，只走 base64 通道。 */
function fakePng(name: string, bytes = 64): string {
	const path = join(dir, name);
	writeFileSync(path, Buffer.alloc(bytes, 7));
	return path;
}

interface Captured {
	model: string;
	context: Context;
	options: SimpleStreamOptions;
}

/** 假流：按给定 delta 吐，最后返回一条 assistant 消息。 */
function fakeStream(
	deltas: readonly string[],
	final: Partial<VisionStreamResult> = {},
): {
	fn: VisionStreamFn;
	seen: Captured[];
} {
	const seen: Captured[] = [];
	const fn: VisionStreamFn = async (model, context, options) => {
		seen.push({ model: model.id, context, options });
		const stream: VisionStream = {
			async *[Symbol.asyncIterator](): AsyncIterator<VisionChunk> {
				for (const delta of deltas) yield { type: "text_delta", delta };
			},
			async result(): Promise<VisionStreamResult> {
				return {
					content: [{ type: "text", text: deltas.join("") }],
					stopReason: "stop",
					usage: { input: 11, output: 7 },
					model: model.id,
					...final,
				};
			},
		};
		return stream;
	};
	return { fn, seen };
}

describe("读图", () => {
	it("按扩展名判 mime，默认当 png", () => {
		assert.equal(mimeOf("a.png"), "image/png");
		assert.equal(mimeOf("a.JPG"), "image/jpeg");
		assert.equal(mimeOf("a.webp"), "image/webp");
		assert.equal(mimeOf("a.unknown"), "image/png");
	});

	it("读成 base64", () => {
		const image = loadImage(fakePng("small.png", 32));
		assert.equal(image.mimeType, "image/png");
		assert.equal(Buffer.from(image.data, "base64").length, 32);
	});

	it("空文件与超限直接抛", () => {
		const empty = join(dir, "empty.png");
		writeFileSync(empty, "");
		assert.throws(() => loadImage(empty), /空文件/);
		const huge = fakePng("huge.png", MAX_IMAGE_BYTES + 1);
		assert.throws(() => loadImage(huge), /图片太大/);
	});
});

describe("看图转述", () => {
	it("把图与问题一起交出去，收下文本与计数", async () => {
		const { fn, seen } = fakeStream(["一张聊天截图：", "对方让你看 MBTI 测试的结果。"]);
		const note: VisionNote = await describeImage(loadImage(fakePng("chat.png", 128)), { stream: fn });
		assert.match(note.text, /一张聊天截图/);
		assert.equal(note.promptTokens, 11);
		assert.equal(note.completionTokens, 7);
		assert.equal(note.bytes, 128);
		assert.equal(seen.length, 1);
		const content = seen[0]?.context.messages[0]?.content;
		assert.ok(Array.isArray(content));
		if (Array.isArray(content)) {
			assert.equal(content[0]?.type, "image");
			assert.equal(content[1]?.type, "text");
		}
		assert.match(seen[0]?.context.systemPrompt ?? "", /看不见图的人/);
	});

	it("可以换掉问法与 system", async () => {
		const { fn, seen } = fakeStream(["ok"]);
		await describeImage(loadImage(fakePng("p.png", 8)), {
			stream: fn,
			prompt: "只念出上面的字",
			system: "你是 OCR",
		});
		const content = seen[0]?.context.messages[0]?.content;
		if (Array.isArray(content)) assert.equal(content[1]?.type === "text" ? content[1].text : "", "只念出上面的字");
		assert.equal(seen[0]?.context.systemPrompt, "你是 OCR");
	});

	it("没有增量时就落到最终消息里取", async () => {
		const { fn } = fakeStream([], { content: [{ type: "text", text: "图里是一个红点" }] });
		const note = await describeImage(loadImage(fakePng("dot.png", 8)), { stream: fn });
		assert.equal(note.text, "图里是一个红点");
	});

	it("模型报错就抛，不吞", async () => {
		const { fn } = fakeStream([], { stopReason: "error", errorMessage: "vision boom" });
		await assert.rejects(() => describeImage(loadImage(fakePng("e.png", 8)), { stream: fn }), /vision boom/);
	});

	it("正文被思考挤掉时加预算再来一次", async () => {
		let calls = 0;
		const fn: VisionStreamFn = async (model, _context, options) => {
			calls += 1;
			const tiny = (options.maxTokens ?? 0) < 2_000;
			const stream: VisionStream = {
				async *[Symbol.asyncIterator](): AsyncIterator<VisionChunk> {
					if (!tiny) yield { type: "text_delta", delta: "第二次看清楚了：一张截图" };
				},
				async result(): Promise<VisionStreamResult> {
					if (tiny) return { content: [], stopReason: "length", model: model.id };
					return {
						content: [{ type: "text", text: "第二次看清楚了：一张截图" }],
						stopReason: "stop",
						model: model.id,
						usage: { input: 5, output: 6 },
					};
				},
			};
			return stream;
		};
		const note = await describeImage(loadImage(fakePng("retry.png", 8)), { stream: fn });
		assert.equal(calls, 2);
		assert.match(note.text, /第二次看清楚了/);
	});

	it("什么都没说也是失败", async () => {
		const { fn } = fakeStream([], { content: [] });
		await assert.rejects(() => describeImage(loadImage(fakePng("n.png", 8)), { stream: fn }), /什么都没说/);
	});
});

describe("图怎么进对话", () => {
	it("转述被包成对方说的话", () => {
		const note = {
			text: "一张截图，上面写着 62 到 78",
			model: "m",
			latencyMs: 1,
			bytes: 1,
			promptTokens: 1,
			completionTokens: 1,
		};
		assert.equal(imageFrame(note), "（对方发来一张图，你看到的是：一张截图，上面写着 62 到 78）");
		assert.match(imageFrame(note, "你看看这个"), /62 到 78）你看看这个$/);
	});
});
