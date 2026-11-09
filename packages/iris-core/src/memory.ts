/** Episodic memory: what happened, when, and how much it mattered. */

import type { Episode } from "./types.ts";

export interface MemoryQuery {
	text?: string;
	tags?: readonly string[];
	limit: number;
}

export interface MemoryStore {
	append(episode: Episode): void;
	recent(limit: number): readonly Episode[];
	search(query: MemoryQuery): readonly Episode[];
}

const SEGMENT = /[\p{L}\p{N}]+/gu;
const HAN = /[\u4e00-\u9fff]/;

/** Lowercases word/number runs; Han runs become bigrams so "看海" still matches "一起看海". */
export function tokenize(text: string): readonly string[] {
	const segments = text.toLowerCase().match(SEGMENT) ?? [];
	const tokens: string[] = [];
	for (const segment of segments) {
		if (!HAN.test(segment)) {
			tokens.push(segment);
			continue;
		}
		if (segment.length === 1) {
			tokens.push(segment);
			continue;
		}
		for (let index = 0; index < segment.length - 1; index += 1) {
			tokens.push(segment.slice(index, index + 2));
		}
	}
	return tokens;
}

export class InMemoryMemoryStore implements MemoryStore {
	private readonly episodes: Episode[] = [];

	append(episode: Episode): void {
		this.episodes.push(episode);
	}

	recent(limit: number): readonly Episode[] {
		return this.episodes.slice(Math.max(0, this.episodes.length - limit)).reverse();
	}

	/** Ranks by keyword overlap, then tag match, then importance, then recency. Non-matches are dropped. */
	search(query: MemoryQuery): readonly Episode[] {
		const wanted = new Set(query.text === undefined ? [] : tokenize(query.text));
		const tags = query.tags ?? [];
		if (wanted.size === 0 && tags.length === 0) return this.recent(query.limit);

		const scored = this.episodes
			.map((episode) => ({ episode, score: scoreEpisode(episode, wanted, tags) }))
			.filter((row) => row.score > 0)
			.sort((a, b) => b.score - a.score || b.episode.at - a.episode.at);

		return scored.slice(0, query.limit).map((row) => row.episode);
	}
}

function scoreEpisode(episode: Episode, wanted: Set<string>, tags: readonly string[]): number {
	const tokens = new Set(tokenize(`${episode.summary} ${episode.tags.join(" ")}`));
	let overlap = 0;
	for (const token of wanted) {
		if (tokens.has(token)) overlap += 1;
	}
	let tagScore = 0;
	for (const tag of tags) {
		if (episode.tags.includes(tag)) tagScore += 0.5;
	}
	if (overlap === 0 && tagScore === 0) return 0;
	const keywordScore = wanted.size === 0 ? 0 : overlap / wanted.size;
	return keywordScore + tagScore + episode.importance * 0.15;
}
