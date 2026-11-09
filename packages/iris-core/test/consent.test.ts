import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsentGrant } from "../src/consent.ts";
import { checkConsent } from "../src/consent.ts";
import type { ActionRequest } from "../src/types.ts";

const speak: ActionRequest = { kind: "speak", text: "早", emotion: "cheerful", interruptible: true };
const game: ActionRequest = { kind: "game.input", game: "stardew", input: "walk north" };
const call: ActionRequest = { kind: "call", to: "+8613800000000", reason: "约朋友吃饭", consentToken: "t-ok" };
const post: ActionRequest = { kind: "post", channel: "douyin", text: "今天直播", consentToken: "t-post" };

function grant(kind: ConsentGrant["kind"], token: string, expiresAt: number): ConsentGrant {
	return { kind, token, grantedAt: 0, expiresAt };
}

describe("checkConsent", () => {
	it("lets conversation-level actions run", () => {
		const decision = checkConsent(speak, [], 100);
		assert.equal(decision.allowed, true);
		assert.equal(decision.requiresAiDisclosure, false);
	});

	it("requires a standing grant for game control", () => {
		assert.equal(checkConsent(game, [], 100).allowed, false);
		assert.equal(checkConsent(game, [grant("game.input", "g", 1000)], 100).allowed, true);
	});

	it("requires the exact token for a call", () => {
		assert.equal(checkConsent(call, [], 100).allowed, false);
		assert.equal(checkConsent(call, [grant("call", "t-wrong", 1000)], 100).allowed, false);
		const ok = checkConsent(call, [grant("call", "t-ok", 1000)], 100);
		assert.equal(ok.allowed, true);
		assert.equal(ok.requiresAiDisclosure, true);
	});

	it("rejects expired grants", () => {
		assert.equal(checkConsent(post, [grant("post", "t-post", 100)], 100).allowed, false);
	});

	it("keeps call and post tokens separate", () => {
		assert.equal(checkConsent(post, [grant("call", "t-post", 1000)], 100).allowed, false);
	});
});
