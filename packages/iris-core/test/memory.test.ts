import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryMemoryStore, tokenize } from "../src/memory.ts";
import type { Episode } from "../src/types.ts";

function episode(id: string, at: number, summary: string, tags: readonly string[], importance: number): Episode {
	return { id, at, kind: "conversation", summary, tags, importance };
}

describe("tokenize", () => {
	it("keeps ascii words and bigrams Han runs", () => {
		assert.deepEqual(tokenize("今天 Streaming 好累!"), ["今天", "streaming", "好累"]);
	});

	it("lets a short Han query match a longer one", () => {
		assert.equal(tokenize("一起看海吧").includes("看海"), true);
		assert.deepEqual(tokenize("看海"), ["看海"]);
	});

	it("returns nothing for punctuation only", () => {
		assert.deepEqual(tokenize("...!!"), []);
	});
});

describe("InMemoryMemoryStore", () => {
	const store = new InMemoryMemoryStore();
	store.append(episode("e1", 1000, "第一次一起看海", ["旅行"], 0.9));
	store.append(episode("e2", 2000, "打了三局都输了", ["游戏"], 0.3));
	store.append(episode("e3", 3000, "直播唱了一首跑调的歌", ["直播"], 0.7));

	it("returns newest first", () => {
		assert.deepEqual(
			store.recent(2).map((item) => item.id),
			["e3", "e2"],
		);
	});

	it("ranks by keyword overlap", () => {
		assert.deepEqual(
			store.search({ text: "看海", limit: 1 }).map((item) => item.id),
			["e1"],
		);
	});

	it("matches tags without letting importance alone qualify", () => {
		assert.deepEqual(
			store.search({ tags: ["直播"], limit: 5 }).map((item) => item.id),
			["e3"],
		);
	});

	it("falls back to recency for an empty query", () => {
		assert.deepEqual(
			store.search({ limit: 1 }).map((item) => item.id),
			["e3"],
		);
	});

	it("drops non-matches instead of padding results", () => {
		assert.deepEqual(store.search({ text: "量子力学", limit: 3 }), []);
	});
});
