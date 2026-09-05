/**
 * recall - search earlier messages in the current thread.
 *
 * pi compacts a long session by replacing older messages with a summary. The
 * messages stay in the session file. They only stop reaching the model. This
 * tool reads them back.
 *
 * Scope: the current session plus the sessions it was forked or cloned from.
 * Never other threads. A match taken from unrelated work reads as
 * authoritative and is usually wrong, so an empty result is the right answer.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 10;
const SNIPPET_CHARS = 400;
const MAX_CHARS = 6000;
const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

interface Hit {
	role: string;
	when: number;
	session: string;
	occurrences: number;
	snippet: string;
}

/** Pulls readable prose out of one session entry, skipping thinking blocks. */
function entryText(entry: any): { role: string; text: string } | undefined {
	if (entry?.type === "compaction") {
		return typeof entry.summary === "string" ? { role: "compaction", text: entry.summary } : undefined;
	}
	if (entry?.type !== "message") return undefined;
	const message = entry.message;
	if (!message) return undefined;

	const role = message.role === "toolResult" ? `tool:${message.toolName ?? "?"}` : message.role;
	const content = message.content;
	if (typeof content === "string") return { role, text: content };
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const part of content) {
		// `thinking` is reasoning we cannot act on, and `toolCall` is arguments
		// rather than prose. Both are noise in a text search.
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? { role, text: parts.join("\n") } : undefined;
}

/** Reads one session file from disk, returning its entries and parent path. */
function readSession(file: string): { entries: any[]; parent?: string } {
	const entries: any[] = [];
	let parent: string | undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			if (typeof entry.parentSession === "string") parent = entry.parentSession;
			continue;
		}
		entries.push(entry);
	}
	return { entries, parent };
}

/**
 * The thread is the live session plus the chain it was forked or cloned from.
 *
 * The live session comes from the session manager rather than from disk, so a
 * search finds the turn that happened a moment ago.
 */
function threadEntries(ctx: ExtensionContext): { entries: any[]; sessions: string[] } {
	const entries: any[] = [...ctx.sessionManager.getEntries()];
	const sessions: string[] = [];

	const file = ctx.sessionManager.getSessionFile();
	sessions.push(file ? file.split("/").pop()! : "current");

	let cursor = file ? readSession(file).parent : undefined;
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		try {
			const parent = readSession(cursor);
			for (const entry of parent.entries) entries.push({ ...entry, __session: cursor.split("/").pop() });
			sessions.push(cursor.split("/").pop()!);
			cursor = parent.parent;
		} catch {
			break;
		}
	}
	return { entries, sessions };
}

function snippetAround(body: string, needle: string): string {
	const at = body.toLowerCase().indexOf(needle);
	if (at < 0) return body.slice(0, SNIPPET_CHARS);
	const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
	const lead = start > 0 ? "…" : "";
	return `${lead}${body.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim()}…`;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at >= 0) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

export default function recall(pi: ExtensionAPI) {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search earlier messages in this thread, including messages that dropped out of context when the session compacted. " +
			"Use it before re-reading files or deciding something this thread may already have decided, and on the first turn after a compaction. " +
			"Only this thread is searched, so an empty result means nothing matched here, not that the subject never came up. " +
			"Matching is literal substring, so prefer a distinctive word or identifier over a sentence.",
		parameters: Type.Object({
			query: Type.String({ description: "Literal text to look for. A distinctive identifier beats a phrase." }),
			limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default ${DEFAULT_LIMIT}).` })),
		}),
		executionMode: "concurrent",
		async execute(_toolCallId: string, params: { query: string; limit?: number }, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const needle = (params.query ?? "").toLowerCase().trim();
			if (needle.length === 0) {
				return { content: [{ type: "text" as const, text: "recall needs a non-empty query." }], details: {} };
			}

			const { entries, sessions } = threadEntries(ctx);
			const now = Date.now();
			const hits: Hit[] = [];

			for (const entry of entries) {
				const extracted = entryText(entry);
				if (!extracted) continue;
				const lower = extracted.text.toLowerCase();
				if (!lower.includes(needle)) continue;
				hits.push({
					role: extracted.role,
					when: Date.parse(entry.timestamp ?? "") || now,
					session: entry.__session ?? sessions[0],
					occurrences: countOccurrences(lower, needle),
					snippet: snippetAround(extracted.text, needle),
				});
			}

			// Recency decides the order, with a nudge for messages that mention the
			// query more than once. Substring matching alone is noisy enough that
			// ordering and the cap matter more than the matching itself.
			hits.sort((a, b) => {
				const score = (h: Hit) =>
					Math.pow(0.5, (now - h.when) / RECENCY_HALF_LIFE_MS) * (1 + Math.log2(h.occurrences + 1));
				return score(b) - score(a);
			});

			const limit = Number.isFinite(params.limit) && (params.limit ?? 0) > 0 ? Math.floor(params.limit!) : DEFAULT_LIMIT;
			const chosen = hits.slice(0, limit);

			if (chosen.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No matches in this thread (searched ${sessions.length} session${sessions.length === 1 ? "" : "s"}). recall only searches the current thread, so this does not mean the subject never came up.`,
						},
					],
					details: { matches: 0, sessions: sessions.length },
				};
			}

			const blocks: string[] = [];
			let used = 0;
			for (const hit of chosen) {
				const stamp = new Date(hit.when).toISOString().replace("T", " ").slice(0, 16);
				const block = `[${stamp}] ${hit.role}\n${hit.snippet}\n`;
				if (used + block.length > MAX_CHARS) break;
				blocks.push(block);
				used += block.length;
			}
			const omitted = chosen.length - blocks.length;
			if (omitted > 0) blocks.push(`(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`);

			return {
				content: [{ type: "text" as const, text: blocks.join("\n") }],
				details: { matches: chosen.length, shown: blocks.length, sessions: sessions.length },
			};
		},
	});
}
