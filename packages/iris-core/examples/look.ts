/**
 * 看一张图：先转述，再让她按自己的脾气接一句。
 *
 *   npm run look -- 图片路径
 *   npm run look -- 图片路径 "你看看这个"
 *   npm run look -- 图片路径 --note-only     只看转述，不叫她说话
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrisSessionEvent } from "../src/session.ts";
import { createSession, imageFrame } from "../src/session.ts";
import type { Persona } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const noteOnly = process.argv.includes("--note-only");
const imagePath = args[0];
const hint = args.slice(1).join(" ");

if (imagePath === undefined) {
	process.stdout.write("用法：npm run look -- <图片路径> [附带一句话] [--note-only]\n");
	process.exit(1);
}

const persona: Persona = {
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

const docPath = join(here, "..", "personas", "senjougahara.md");
const session = createSession({
	persona,
	personaDoc: readFileSync(docPath, "utf8"),
	stageDirections: false,
});

const note = await session.look(imagePath);
process.stdout.write(`\n看到：${note.text}\n`);
process.stdout.write(
	`  · ${note.model} / ${note.latencyMs} ms / ${Math.round(note.bytes / 1024)} KB / prompt ${note.promptTokens} · completion ${note.completionTokens}\n`,
);

if (!noteOnly) {
	const onEvent = (event: IrisSessionEvent): void => {
		if (event.type === "delta") process.stdout.write(event.text);
	};
	process.stdout.write(`\n${persona.name}：`);
	const turn = await session.say(imageFrame(note, hint), { onEvent });
	process.stdout.write(`\n  · ${turn.firstTokenMs} ms 首字 / ${turn.latencyMs} ms · ${turn.text.length} 字\n`);
}
