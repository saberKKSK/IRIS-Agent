import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InitiativeContext } from "../src/initiative.ts";
import { proposeInitiative } from "../src/initiative.ts";

function context(overrides: Partial<InitiativeContext>): InitiativeContext {
	return {
		state: {
			mood: { label: "calm", valence: 0.2, arousal: 0.3, updatedAt: 0 },
			energy: 0.7,
			activity: "陪用户打游戏",
			speaking: false,
		},
		relationship: { closeness: 0.6, sharedMoments: 9, lastInteractionAt: 0 },
		now: 3600000,
		localHour: 15,
		idleMinutes: 20,
		lastInitiativeAt: 0,
		...overrides,
	};
}

describe("proposeInitiative", () => {
	it("speaks up when the user has gone quiet mid-day", () => {
		const request = proposeInitiative(context({}));
		assert.equal(request?.kind, "initiate");
		assert.match(request?.kind === "initiate" ? request.topic : "", /那一波/);
	});

	it("stays silent during quiet hours, including across midnight", () => {
		assert.equal(proposeInitiative(context({ localHour: 3 })), null);
		assert.equal(proposeInitiative(context({ localHour: 23 })), null);
		assert.notEqual(proposeInitiative(context({ localHour: 9 })), null);
	});

	it("respects the cooldown", () => {
		assert.equal(proposeInitiative(context({ lastInitiativeAt: 3600000 - 60000 })), null);
	});

	it("does not interrupt an active conversation", () => {
		assert.equal(proposeInitiative(context({ idleMinutes: 3 })), null);
	});

	it("holds back when energy is gone", () => {
		const request = proposeInitiative(
			context({
				state: {
					mood: { label: "tired", valence: -0.2, arousal: 0.1, updatedAt: 0 },
					energy: 0.1,
					activity: "陪用户打游戏",
					speaking: false,
				},
			}),
		);
		assert.equal(request, null);
	});
});
