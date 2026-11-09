/** Decides whether IRIS should start an interaction on her own, and about what. */

import type { ActionRequest, PersonaState, Relationship } from "./types.ts";

export interface InitiativeContext {
	state: PersonaState;
	relationship: Relationship;
	now: number;
	localHour: number;
	idleMinutes: number;
	lastInitiativeAt: number;
	quietHours?: { start: number; end: number };
	cooldownMinutes?: number;
	idleThresholdMinutes?: number;
}

const DEFAULT_QUIET_HOURS = { start: 23, end: 8 };
const DEFAULT_COOLDOWN_MINUTES = 45;
const DEFAULT_IDLE_THRESHOLD_MINUTES = 10;

/** Returns an initiate request, or null when IRIS should stay quiet. Denies on every missing input. */
export function proposeInitiative(context: InitiativeContext): ActionRequest | null {
	const quiet = context.quietHours ?? DEFAULT_QUIET_HOURS;
	const cooldown = context.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
	const idleThreshold = context.idleThresholdMinutes ?? DEFAULT_IDLE_THRESHOLD_MINUTES;

	if (inQuietHours(context.localHour, quiet)) return null;
	if (context.idleMinutes < idleThreshold) return null;
	if (context.now - context.lastInitiativeAt < cooldown * 60000) return null;
	if (context.state.energy < 0.15) return null;

	return { kind: "initiate", topic: chooseTopic(context), urgency: "low" };
}

function chooseTopic(context: InitiativeContext): string {
	const activity = context.state.activity;
	if (activity.includes("游戏")) return "刚才那一波你是怎么想的？";
	if (activity.includes("旅行") || activity.includes("外面")) return "现在这片景色你还想多待一会儿吗？";
	if (activity.includes("直播")) return "弹幕在聊什么？挑一条说说。";
	if (context.state.mood.label === "tired") return "你看起来有点累，要不要先歇一会儿？";
	if (context.localHour < 12) return "早，今天想先做什么？";
	if (context.relationship.closeness < 0.3) return "你在忙吗？我可以安静待着。";
	return "刚看到一个挺有意思的东西，想跟你说。";
}

function inQuietHours(hour: number, quiet: { start: number; end: number }): boolean {
	if (quiet.start === quiet.end) return false;
	return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}
