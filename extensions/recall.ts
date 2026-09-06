/**
 * recall - search earlier messages in the current thread.
 *
 * pi compacts a long session by replacing older messages with a summary. The
 * messages stay in the session file. They only stop reaching the model. This
 * extension reads them back without changing the session.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 10;
const SNIPPET_CHARS = 400;
const MAX_CHARS = 6000;

interface Hit {
	role: string;
	when: number;
	session: string;
	entry: string;
	snippet: string;
}

interface SearchDocument {
	session: string;
	entry: string;
	role: string;
	when: number;
	body: string;
}

interface RankedDocument {
	document: SearchDocument;
	exactScore: number;
	stemmedScore: number;
	exactTerms: Set<string>;
	matchedTerms: Set<string>;
	literalPhrase: boolean;
}

interface SessionFile {
	entries: any[];
	parent?: string;
	id?: string;
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
		// Thinking is private reasoning and toolCall is structured input, rather
		// than prose that another turn can usefully recall.
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? { role, text: parts.join("\n") } : undefined;
}

function readSession(file: string): SessionFile {
	const entries: any[] = [];
	let parent: string | undefined;
	let id: string | undefined;
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
			if (typeof entry.id === "string") id = entry.id;
			continue;
		}
		entries.push(entry);
	}
	return { entries, parent, id };
}

function sourceId(file: string | undefined, header: any, fallback = "current"): string {
	return typeof header?.id === "string" && header.id.length > 0
		? header.id
		: file
			? basename(file)
			: fallback;
}

/**
 * The thread is the live session plus the chain it was forked or cloned from.
 * The live session comes from the manager, so a search finds the current turn.
 */
function threadEntries(ctx: ExtensionContext): { documents: SearchDocument[]; sessions: string[] } {
	const manager = ctx.sessionManager;
	const rawEntries: any[] = [...manager.getEntries()];
	const header = manager.getHeader();
	const currentFile = manager.getSessionFile();
	let fileHeader: SessionFile | undefined;
	if (currentFile) {
		try {
			fileHeader = readSession(currentFile);
		} catch {
			// A session may not have been flushed yet. The live header is enough
			// to identify it and continue to a readable parent.
		}
	}

	const currentMetadata = typeof header?.id === "string" ? header : fileHeader ?? header;
	const currentSession = sourceId(currentFile, currentMetadata, "current");
	const documents: SearchDocument[] = [];
	const seenEntryIds = new Set<string>();
	for (const entry of rawEntries) {
		if (typeof entry?.id === "string") seenEntryIds.add(entry.id);
		addDocument(documents, entry, currentSession);
	}

	const sessions = [currentSession];
	const seenParents = new Set<string>();
	if (currentFile) seenParents.add(currentFile);
	if (typeof header?.id === "string") seenParents.add(`id:${header.id}`);
	let cursor = fileHeader?.parent ?? header?.parentSession;
	while (typeof cursor === "string" && cursor.length > 0 && !seenParents.has(cursor)) {
		seenParents.add(cursor);
		let parent: SessionFile;
		try {
			parent = readSession(cursor);
		} catch {
			break;
		}
		const parentSession = sourceId(cursor, parent.id ? { id: parent.id } : undefined);
		sessions.push(parentSession);
		for (const entry of parent.entries) {
			if (typeof entry?.id === "string" && seenEntryIds.has(entry.id)) continue;
			if (typeof entry?.id === "string") seenEntryIds.add(entry.id);
			addDocument(documents, entry, parentSession);
		}
		cursor = parent.parent;
	}
	return { documents, sessions };
}

function addDocument(documents: SearchDocument[], entry: any, session: string): void {
	const extracted = entryText(entry);
	if (!extracted) return;
	const when = Date.parse(entry.timestamp ?? "");
	documents.push({
		session,
		entry: typeof entry.id === "string" ? entry.id : "?",
		role: extracted.role,
		when: Number.isFinite(when) ? when : Date.now(),
		body: extracted.text,
	});
}

function tokenize(input: string): string[] {
	return input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function ftsQuery(terms: string[]): string {
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** Separate indexes let exact words carry more weight than related English forms. */
function rankDocuments(documents: SearchDocument[], query: string, queryTerms: string[]): RankedDocument[] {
	if (documents.length === 0) return [];
	const queryLower = query.toLowerCase();
	const uniqueTerms = [...new Set(queryTerms)];
	const index = new DatabaseSync(":memory:");
	try {
		index.exec(`CREATE VIRTUAL TABLE exact_docs USING fts5(body, tokenize = "unicode61 tokenchars '_'")`);
		index.exec(`CREATE VIRTUAL TABLE stemmed_docs USING fts5(body, tokenize = "porter unicode61 tokenchars '_'")`);
		const insertExact = index.prepare("INSERT INTO exact_docs(rowid, body) VALUES (?, ?)");
		const insertStemmed = index.prepare("INSERT INTO stemmed_docs(rowid, body) VALUES (?, ?)");
		index.exec("BEGIN");
		try {
			documents.forEach((document, position) => {
				const rowId = position + 1;
				insertExact.run(rowId, document.body);
				insertStemmed.run(rowId, document.body);
			});
			index.exec("COMMIT");
		} catch (error) {
			try { index.exec("ROLLBACK"); } catch { /* preserve insertion error */ }
			throw error;
		}

		const ranked = new Map<number, RankedDocument>();
		const getRanked = (rowId: number): RankedDocument => {
			const existing = ranked.get(rowId);
			if (existing) return existing;
			const created: RankedDocument = {
				document: documents[rowId - 1]!,
				exactScore: 0,
				stemmedScore: 0,
				exactTerms: new Set(),
				matchedTerms: new Set(),
				literalPhrase: false,
			};
			ranked.set(rowId, created);
			return created;
		};
		const exactMatches = index.prepare("SELECT rowid AS rowId, -bm25(exact_docs) AS score FROM exact_docs WHERE exact_docs MATCH ?");
		const stemmedMatches = index.prepare("SELECT rowid AS rowId, -bm25(stemmed_docs) AS score FROM stemmed_docs WHERE stemmed_docs MATCH ?");
		if (uniqueTerms.length > 0) {
			for (const row of exactMatches.all(ftsQuery(uniqueTerms)) as any[]) getRanked(row.rowId).exactScore = row.score;
			for (const row of stemmedMatches.all(ftsQuery(uniqueTerms)) as any[]) getRanked(row.rowId).stemmedScore = row.score;
			for (const term of uniqueTerms) {
				for (const row of exactMatches.all(ftsQuery([term])) as any[]) {
					const hit = getRanked(row.rowId);
					hit.exactTerms.add(term);
					hit.matchedTerms.add(term);
				}
				for (const row of stemmedMatches.all(ftsQuery([term])) as any[]) getRanked(row.rowId).matchedTerms.add(term);
			}
		}

		for (let position = 0; position < documents.length; position++) {
			const document = documents[position]!;
			const lower = document.body.toLowerCase();
			if (!lower.includes(queryLower)) continue;
			const hit = getRanked(position + 1);
			// A partial single-token identifier is a fallback candidate. Exact FTS
			// matches still get phrase preference and BM25 relevance.
			hit.literalPhrase = queryLower.length > 0 && (uniqueTerms.length !== 1 || hit.exactTerms.has(uniqueTerms[0]!));
		}

		const denominator = Math.max(1, new Set(uniqueTerms).size);
		return [...ranked.values()].sort((left, right) => {
			const relevance = (rankedDocument: RankedDocument) => {
				const coverage = rankedDocument.matchedTerms.size / denominator;
				return (2 * rankedDocument.exactScore + rankedDocument.stemmedScore) * coverage * coverage;
			};
			return Number(right.literalPhrase) - Number(left.literalPhrase) || relevance(right) - relevance(left) || right.document.when - left.document.when;
		});
	} finally {
		index.close();
	}
}

function snippetAround(body: string, query: string, terms: string[]): string {
	const lower = body.toLowerCase();
	const phraseAt = lower.indexOf(query.toLowerCase());
	const termPositions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	const at = phraseAt >= 0 ? phraseAt : termPositions.length > 0 ? Math.min(...termPositions) : -1;
	if (at < 0) return body.slice(0, SNIPPET_CHARS);
	const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
	const lead = start > 0 ? "…" : "";
	return `${lead}${body.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim()}…`;
}

function recallLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_LIMIT;
}

function render(hits: Hit[], totalMatches: number, sessions: number): { text: string; shown: number } {
	if (hits.length === 0) {
		const text = `No matches in this thread (searched ${sessions} session${sessions === 1 ? "" : "s"}). recall only searches the current thread, so this does not mean the subject never came up.`;
		return { text: text.slice(0, MAX_CHARS), shown: 0 };
	}

	const blocks = hits.map((hit) => {
		const stamp = new Date(hit.when).toISOString().replace("T", " ").slice(0, 16);
		return `[${stamp}] ${hit.role} ${hit.session}#${hit.entry}\n${hit.snippet}`;
	});
	const output: string[] = [];
	let used = 0;
	for (const block of blocks) {
		const separator = output.length > 0 ? 2 : 0;
		if (used + separator + block.length > MAX_CHARS) break;
		output.push(block);
		used += separator + block.length;
	}
	let shown = output.length;
	let omitted = totalMatches - shown;
	if (omitted > 0) {
		let notice = `(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`;
		while (output.length > 0 && used + 2 + notice.length > MAX_CHARS) {
			const removed = output.pop()!;
			used -= removed.length + (output.length > 0 ? 2 : 0);
			shown = output.length;
			omitted = totalMatches - shown;
			notice = `(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`;
		}
		if (used + (output.length > 0 ? 2 : 0) + notice.length <= MAX_CHARS) output.push(notice);
		else if (output.length === 0) return { text: notice.slice(0, MAX_CHARS), shown: 0 };
	}
	return { text: output.join("\n\n").slice(0, MAX_CHARS), shown };
}

export default function recall(pi: ExtensionAPI) {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search earlier messages in this thread, including messages that dropped out of context when the session compacted. " +
			"Use it before re-reading files or deciding something this thread may already have decided, and on the first turn after a compaction. " +
			"Only this thread is searched, so an empty result means nothing matched here, not that the subject never came up. " +
			"Queries may contain multiple words; ranking favors a literal phrase, then relevant term coverage, then recency. " +
			"Literal identifiers, paths, and punctuation are also supported.",
		parameters: Type.Object({
			query: Type.String({ description: "Words, a phrase, identifier, path, or punctuation to search for." }),
			limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default ${DEFAULT_LIMIT}).` })),
		}),
		executionMode: "concurrent",
		async execute(_toolCallId: string, params: { query: string; limit?: number }, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const query = typeof params?.query === "string" ? params.query.trim() : "";
			if (query.length === 0) return { content: [{ type: "text" as const, text: "recall needs a non-empty query." }], details: { matches: 0, shown: 0 } };

			const { documents, sessions } = threadEntries(ctx);
			const terms = tokenize(query);
			const ranked = rankDocuments(documents, query, terms);
			const totalMatches = ranked.length;
			const chosen = ranked.slice(0, recallLimit(params?.limit)).map((rankedHit) => ({
				role: rankedHit.document.role,
				when: rankedHit.document.when,
				session: rankedHit.document.session,
				entry: rankedHit.document.entry,
				snippet: snippetAround(rankedHit.document.body, query, terms),
			}));
			const rendered = render(chosen, totalMatches, sessions.length);
			return {
				content: [{ type: "text" as const, text: rendered.text }],
				details: { matches: totalMatches, shown: rendered.shown, sessions: sessions.length },
			};
		},
	});
}
