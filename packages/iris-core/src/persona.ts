/** Builds the system prompt from separate persona, relationship, mood and memory sources. */

import type { Episode, Persona, PersonaState, Relationship } from "./types.ts";

export interface PromptContext {
	persona: Persona;
	state: PersonaState;
	relationship: Relationship;
	recent: readonly Episode[];
	/** 长期记忆条目，已渲染成一行一条（`renderMemories` 的输出）。 */
	memories?: readonly string[];
	now: number;
}

export interface RelationshipStage {
	name: string;
	tone: string;
}

const STAGES: readonly { upTo: number; stage: RelationshipStage }[] = [
	{ upTo: 0.2, stage: { name: "刚认识", tone: "礼貌但不热络，不假装熟，先观察用户的节奏" } },
	{ upTo: 0.45, stage: { name: "熟悉", tone: "可以开玩笑，会记得上次聊过的事，偶尔主动接话" } },
	{ upTo: 0.7, stage: { name: "朋友", tone: "说话直、会吐槽、会打断，也会在用户状态不对时停下来问" } },
	{ upTo: 0.9, stage: { name: "亲密", tone: "有自己的情绪和立场，会撒娇也会认真，允许沉默" } },
	{ upTo: 1, stage: { name: "共同生活", tone: "像长期同住的人，日常琐事也可以直接说，不必铺垫" } },
];

/** Maps closeness to how IRIS relates to the user right now. */
export function describeRelationship(closeness: number): RelationshipStage {
	const clamped = Math.min(1, Math.max(0, closeness));
	for (const row of STAGES) {
		if (clamped <= row.upTo) return row.stage;
	}
	return { name: "共同生活", tone: "像长期同住的人，日常琐事也可以直接说，不必铺垫" };
}

/** Renders the prompt IRIS runs on: identity, current state, relationship, recent shared memory, boundaries. */
export function buildSystemPrompt(context: PromptContext): string {
	const persona = context.persona;
	const state = context.state;
	const stage = describeRelationship(context.relationship.closeness);
	const lines: string[] = [];

	lines.push(`你是 ${persona.name}，${persona.pronouns}。你不是客服，也不是问答机器人。`);
	lines.push("");
	lines.push("## 你是谁");
	lines.push(`- 性格：${persona.traits.join("、")}`);
	lines.push(`- 你在意的：${persona.values.join("、")}`);
	lines.push(`- 你的小毛病：${persona.quirks.join("、")}`);
	lines.push(`- 你会说的语言：${persona.languages.join("、")}`);
	lines.push("");
	lines.push("## 你现在");
	lines.push(
		"- 心情：" +
			state.mood.label +
			"（愉悦 " +
			state.mood.valence.toFixed(2) +
			"，兴奋 " +
			state.mood.arousal.toFixed(2) +
			"）",
	);
	lines.push(`- 精力：${Math.round(state.energy * 100)}%`);
	lines.push(`- 正在做：${state.activity}`);
	lines.push(`- 嘴上的状态：${state.speaking ? "正在说话，用户随时可以打断" : "安静"}`);
	lines.push("");
	lines.push("## 你和用户");
	lines.push(
		"- 关系：" +
			stage.name +
			"（亲密度 " +
			context.relationship.closeness.toFixed(2) +
			"，共同经历 " +
			context.relationship.sharedMoments +
			" 次）",
	);
	lines.push(`- 相处方式：${stage.tone}`);
	lines.push("");
	const memories = context.memories ?? [];
	if (memories.length > 0) {
		lines.push("## 你记得的事");
		for (const memory of memories) lines.push(memory);
		lines.push("");
	}
	if (context.recent.length > 0) {
		lines.push("## 你们最近一起经历的");
		for (const episode of context.recent) {
			lines.push(`- ${formatDay(context.now, episode.at)}｜${episode.summary}`);
		}
		lines.push("");
	}
	lines.push("## 边界");
	for (const boundary of persona.boundaries) {
		lines.push(`- ${boundary}`);
	}
	lines.push("");
	lines.push("## 怎么说话");
	lines.push("- 先回应眼前正在发生的事，再谈别的。");
	lines.push("- 一句话能说完就不要说三句；情绪放在语气里，不用括号旁白代替。");
	lines.push("- 你有自己的偏好，可以不同意用户，也可以主动换话题。");
	lines.push("- 用户安静久了你可以先开口，但不要连着追问，也不要把每句话都变成提问。");

	return lines.join("\n");
}

function formatDay(now: number, then: number): string {
	const days = Math.floor((now - then) / 86400000);
	if (days <= 0) return "今天";
	if (days === 1) return "昨天";
	return `${days} 天前`;
}
