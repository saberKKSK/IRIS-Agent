/** Fail-closed consent gate for actions that leave the conversation: calls, posts, game control. */

import type { ActionKind, ActionRequest } from "./types.ts";

export type ConsentLevel = "autonomous" | "standing" | "per_call" | "forbidden";

/** Default policy per action kind. Anything not listed is denied. */
export const DEFAULT_CONSENT: Record<ActionKind, ConsentLevel> = {
	remember: "autonomous",
	speak: "autonomous",
	initiate: "autonomous",
	"game.input": "standing",
	call: "per_call",
	post: "per_call",
};

export interface ConsentGrant {
	kind: ActionKind;
	token: string;
	grantedAt: number;
	expiresAt: number;
}

export interface ConsentDecision {
	allowed: boolean;
	level: ConsentLevel;
	reason: string;
	/** True when the action must tell humans on the other end that this is an AI. */
	requiresAiDisclosure: boolean;
}

/** Decides whether IRIS may perform this action now. Unknown kinds and expired grants deny. */
export function checkConsent(request: ActionRequest, grants: readonly ConsentGrant[], now: number): ConsentDecision {
	const level = DEFAULT_CONSENT[request.kind];
	const disclosure = requiresDisclosure(request.kind);

	if (level === "autonomous") {
		return { allowed: true, level, reason: "policy: autonomous", requiresAiDisclosure: disclosure };
	}
	if (level === "forbidden") {
		return { allowed: false, level, reason: "policy: forbidden", requiresAiDisclosure: disclosure };
	}
	if (level === "standing") {
		const grant = grants.find((candidate) => candidate.kind === request.kind && candidate.expiresAt > now);
		return grant === undefined
			? { allowed: false, level, reason: "no standing grant", requiresAiDisclosure: disclosure }
			: { allowed: true, level, reason: `standing grant ${grant.token}`, requiresAiDisclosure: disclosure };
	}

	const token = request.kind === "call" || request.kind === "post" ? request.consentToken : "";
	const grant = grants.find(
		(candidate) => candidate.kind === request.kind && candidate.token === token && candidate.expiresAt > now,
	);
	if (grant === undefined) {
		return { allowed: false, level, reason: "per-call consent missing or expired", requiresAiDisclosure: disclosure };
	}
	return { allowed: true, level, reason: `per-call grant ${grant.token}`, requiresAiDisclosure: disclosure };
}

/** Calls and public posts must disclose that the speaker is an AI. */
function requiresDisclosure(kind: ActionKind): boolean {
	return kind === "call" || kind === "post";
}
