/**
 * 导入语料，让 IRIS 照着说话。
 *
 *   node examples/corpus-import.ts <文件或目录...> [--name 小鹿] [--speaker 小鹿] [--summarize] [--reply "在干嘛"]
 *
 * 不带 --reply 只看档案；带了就顺手让会话用这份档案回一句，验证接得上。
 */

import { basename } from "node:path";
import {
	createSession,
	defaultArchivePath,
	importStyle,
	readCorpus,
	renderStyle,
	SqliteArchive,
	speakersOf,
	toneFlags,
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

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

const has = (name: string): boolean => process.argv.includes(name);

const FLAGS_WITH_VALUE = new Set(["--name", "--speaker", "--reply"]);
const paths: string[] = [];
for (let index = 0; index < process.argv.slice(2).length; index += 1) {
	const arg = process.argv.slice(2)[index];
	if (arg === undefined) continue;
	if (FLAGS_WITH_VALUE.has(arg)) {
		index += 1;
		continue;
	}
	if (arg.startsWith("--")) continue;
	paths.push(arg);
}

if (paths.length === 0) {
	console.error("用法：node examples/corpus-import.ts <文件或目录...> [--name 小鹿] [--speaker 小鹿] [--summarize]");
	process.exit(1);
}

const files = readCorpus(paths);
if (files.length === 0) {
	console.error("没读到文本语料（支持 .txt / .md / .jsonl / .json / .csv / .log）");
	process.exit(1);
}

const speakers = speakersOf(files);
const wanted = flag("--speaker") ?? speakers[0]?.token;
const name = flag("--name") ?? wanted ?? basename(paths[0] ?? "corpus");

console.log(
	"读到 " + files.length + " 个文件，共 " + files.reduce((total, file) => total + file.text.length, 0) + " 字",
);
if (speakers.length > 0) {
	console.log(
		"说话人：" +
			speakers
				.slice(0, 6)
				.map((row) => row.token + " " + row.count + " 句")
				.join("、"),
	);
	console.log("学的对象：" + (wanted ?? "（不区分）"));
}

const profile = await importStyle(name, files, {
	speaker: wanted,
	summarize: has("--summarize"),
	onError: (error) => console.error("模型归纳失败，档案照旧：" + String(error)),
});

const archive = new SqliteArchive({ path: defaultArchivePath() });
archive.saveStyle(profile);
console.log("");
console.log("档案已存进 " + defaultArchivePath() + "，当前生效：" + (archive.style()?.name ?? "无"));
console.log(
	"句数 " +
		profile.utterances +
		"｜字数 " +
		profile.chars +
		"｜平均 " +
		profile.avgChars +
		" 字｜中位 " +
		profile.medianChars +
		" 字｜九成 ≤ " +
		profile.p90Chars +
		" 字",
);
console.log(
	"标点/千字：逗号 " +
		profile.punctuationPer1000.comma +
		"、句号 " +
		profile.punctuationPer1000.period +
		"、问号 " +
		profile.punctuationPer1000.question +
		"、省略号 " +
		profile.punctuationPer1000.ellipsis +
		"、破折号 " +
		profile.punctuationPer1000.dash,
);
if (profile.particles.length > 0) {
	console.log(
		"语气词：" +
			profile.particles
				.slice(0, 8)
				.map((row) => row.token + " " + row.count)
				.join("、"),
	);
}
if (profile.catchphrases.length > 0) {
	console.log("口癖：" + profile.catchphrases.map((row) => row.token + "×" + row.count).join("、"));
}
console.log("原话样本：" + profile.samples.map((sample) => "「" + sample + "」").join(" "));
if (profile.summary !== undefined) console.log("模型归纳：" + profile.summary);

const flags = profile.samples.flatMap((sample) => toneFlags(sample));
console.log(
	"AI 味扫描（样本 " +
		profile.samples.length +
		" 条）：" +
		(flags.length === 0 ? "干净" : flags.map((flag) => flag.label).join("、")),
);

console.log("");
console.log("—— 进 prompt 的样子 ——");
console.log(renderStyle(profile));

const reply = flag("--reply");
if (reply !== undefined) {
	const session = createSession({ persona: PERSONA, archive });
	const turn = await session.say(reply, {
		onEvent(event) {
			if (event.type === "delta") process.stdout.write(event.text);
		},
	});
	console.log("");
	console.log(
		"（" +
			turn.model +
			"，首字 " +
			turn.firstTokenMs +
			" ms，整轮 " +
			turn.latencyMs +
			" ms，prompt " +
			turn.usage.promptTokens +
			" / completion " +
			turn.usage.completionTokens +
			"）",
	);
	await session.endConversation();
}

archive.close();
