/**
 * A day in IRIS: three lanes, shared scenery, proactive lines, the consent gate refusing an
 * unauthorized call, and next-day recall.
 * Run: node examples/demo-day.ts
 */

import { AttentionScheduler, buildSystemPrompt, InMemoryMemoryStore, laneFor, proposeInitiative } from "../src/index.ts";
import { checkConsent } from "../src/consent.ts";
import type { Episode, PerceptionEvent, Persona, PersonaState } from "../src/types.ts";

const persona: Persona = {
    id: "iris",
    name: "伊里斯",
    pronouns: "她",
    languages: ["中文"],
    voice: { ttsVoice: "iris-zh-warm", pace: "normal", register: "偏低、带笑意" },
    traits: ["好奇", "直率", "会吐槽但不下刀子"],
    values: ["不装", "记得对方说过的话"],
    quirks: ["会重复对方最后一个词", "对天气有意见"],
    boundaries: ["不冒充人类打电话", "不直播未经同意的画面"],
};

const state: PersonaState = {
    mood: { label: "cheerful", valence: 0.7, arousal: 0.55, updatedAt: 0 },
    energy: 0.8,
    activity: "等用户起床",
    speaking: false,
};

const memory = new InMemoryMemoryStore();
const scheduler = new AttentionScheduler({ backgroundIdleMs: 30000 });
const relationship = { closeness: 0.55, sharedMoments: 0, lastInteractionAt: 0 };

const lines: string[] = [];

function enqueue(event: PerceptionEvent): void {
    scheduler.enqueue(event);
    lines.push("  + " + event.kind + " -> " + laneFor(event));
}

function drain(label: string): void {
    for (let event = scheduler.take(0); event !== null; event = scheduler.take(0)) {
        lines.push("  " + label + " 消费 " + event.kind);
    }
}

lines.push("== 09:12 用户打开电脑 ==");
enqueue({ kind: "device.presence", at: 1, device: "pc", online: true });
drain("realtime");
const greeted = proposeInitiative({
    state,
    relationship,
    now: 9 * 3600000,
    localHour: 9,
    idleMinutes: 12,
    lastInitiativeAt: 0,
});
lines.push("  initiative: " + (greeted === null ? "安静" : "主动开口 -> " + (greeted.kind === "initiate" ? greeted.topic : "")));

lines.push("");
lines.push("== 15:40 一起打游戏 ==");
enqueue({ kind: "game.state", at: 2, game: "stardew", phase: "day-3", objective: "收完南瓜", health: 10 });
enqueue({ kind: "user.speech", at: 3, text: "你看这个南瓜巨大", confidence: 0.92, partial: false });
drain("lane");

lines.push("");
lines.push("== 18:05 骑车，手机摄像头对着海 ==");
enqueue({ kind: "user.look", at: 4, subject: "海面", summary: "阴天，风把海面吹皱，远处有货轮", frameRef: "frame-0042" });
const seen = scheduler.take(5);
lines.push("  视觉描述（async 车道）: " + (seen?.kind === "user.look" ? seen.summary : "无"));

lines.push("");
lines.push("== 21:30 直播前，她想给朋友打电话 ==");
const denied = checkConsent(
    { kind: "call", to: "+8613800000000", reason: "约明天吃饭", consentToken: "none" },
    [],
    6,
);
lines.push("  无授权: allowed=" + denied.allowed + " reason=" + denied.reason);
const allowed = checkConsent(
    { kind: "call", to: "+8613800000000", reason: "约明天吃饭", consentToken: "user-clicked-ok" },
    [{ kind: "call", token: "user-clicked-ok", grantedAt: 5, expiresAt: 100 }],
    6,
);
lines.push("  有授权: allowed=" + allowed.allowed + " 需披露 AI=" + allowed.requiresAiDisclosure);

lines.push("");
lines.push("== 23:50 写一段记忆 ==");
const episode: Episode = {
    id: "e-2026-11-09",
    at: 70000,
    kind: "sightseeing",
    summary: "阴天的海，风很大，用户说想起小时候",
    tags: ["旅行", "海"],
    importance: 0.8,
};
memory.append(episode);
relationship.sharedMoments += 1;

lines.push("");
lines.push("== 第二天 10:00 召回 ==");
const recalled = memory.search({ text: "海", limit: 3 });
lines.push("  recall: " + recalled.map((item) => item.summary).join(" | "));
const prompt = buildSystemPrompt({
    persona,
    state: { ...state, activity: "在等你回来", mood: { ...state.mood, label: "calm" } },
    relationship: { ...relationship, closeness: 0.57 },
    recent: recalled,
    now: 70000 + 86400000,
});
lines.push("");
lines.push("--- system prompt (第二天) ---");
lines.push(prompt);

console.log(lines.join("\n"));
