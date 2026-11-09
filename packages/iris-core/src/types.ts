/** Core IRIS domain vocabulary: the states and events the runtime reasons about. */

export type Lane = "realtime" | "async" | "background";

export type MoodLabel = "cheerful" | "calm" | "playful" | "focused" | "tired" | "excited" | "concerned";

export interface Mood {
	label: MoodLabel;
	/** -1 (unhappy) .. 1 (happy). */
	valence: number;
	/** 0 (still) .. 1 (worked up). */
	arousal: number;
	updatedAt: number;
}

export interface Relationship {
	/** 0 (stranger) .. 1 (intimate). */
	closeness: number;
	sharedMoments: number;
	lastInteractionAt: number;
}

export interface VoiceProfile {
	ttsVoice: string;
	pace: "slow" | "normal" | "fast";
	register: string;
}

export interface Persona {
	id: string;
	name: string;
	pronouns: string;
	languages: readonly string[];
	voice: VoiceProfile;
	traits: readonly string[];
	values: readonly string[];
	quirks: readonly string[];
	/** Things IRIS will not do, in her own voice. Enforced by the consent gate, not by the prompt alone. */
	boundaries: readonly string[];
}

export interface PersonaState {
	mood: Mood;
	/** 0 (drained) .. 1 (full). */
	energy: number;
	/** Human-readable current activity, e.g. "陪用户打游戏". */
	activity: string;
	speaking: boolean;
}

export type PerceptionEvent =
	| { kind: "user.speech"; at: number; text: string; confidence: number; partial: boolean }
	| { kind: "user.look"; at: number; subject: string; summary: string; frameRef: string }
	| { kind: "game.state"; at: number; game: string; phase: string; objective: string; health: number | null }
	| { kind: "device.presence"; at: number; device: "pc" | "android"; online: boolean }
	| { kind: "clock.tick"; at: number; localHour: number; localMinute: number }
	| { kind: "user.idle"; at: number; idleMinutes: number };

export type EpisodeKind = "conversation" | "game" | "sightseeing" | "performance" | "call" | "event";

export interface Episode {
	id: string;
	at: number;
	kind: EpisodeKind;
	summary: string;
	tags: readonly string[];
	/** 0 .. 1; drives recall ranking and what survives compaction. */
	importance: number;
}

export type ActionRequest =
	| { kind: "speak"; text: string; emotion: MoodLabel; interruptible: boolean }
	| { kind: "initiate"; topic: string; urgency: "low" | "normal" }
	| { kind: "game.input"; game: string; input: string }
	| { kind: "call"; to: string; reason: string; consentToken: string }
	| { kind: "post"; channel: string; text: string; consentToken: string }
	| { kind: "remember"; episode: Episode };

export type ActionKind = ActionRequest["kind"];
