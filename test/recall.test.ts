import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import recall from "../extensions/recall.ts";

type Entry = Record<string, unknown>;

function message(id: string, text: string, timestamp: string, parentId: string | null = null, content?: unknown[]): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: content ?? [{ type: "text", text }] },
	};
}

async function invoke({ entries, file, header, query = "sqlite fts", limit = 10 }: { entries: Entry[]; file?: string; header?: Entry; query?: string; limit?: number }) {
	let tool: any;
	recall({ registerTool(value: any) { tool = value; } } as any);
	const context = {
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => file,
			getHeader: () => header,
		},
	};
	return tool.execute("test", { query, limit }, undefined, undefined, context);
}

async function sessionFile(path: string, id: string, entries: Entry[], parentSession?: string) {
	await writeFile(path, [
		JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00.000Z", parentSession }),
		...entries.map((entry) => JSON.stringify(entry)),
	].join("\n") + "\n");
}

function resultText(result: any): string {
	return result.content[0].text;
}

test("reports source session and entry IDs for ranked matches", async () => {
	const dir = await mkdtemp(join(tmpdir(), "recall-"));
	const file = join(dir, "current.jsonl");
	await sessionFile(file, "current-session", []);
	const result = await invoke({
		file,
		header: { type: "session", id: "current-session", timestamp: "2025-01-01T00:00:00.000Z" },
		entries: [message("entry-1", "sqlite fts is useful", "2025-01-01T00:00:00.000Z")],
	});
	assert.match(resultText(result), /current-session#entry-1/);
});

test("supports noncontiguous terms and prefers a literal phrase over relevance and recency", async () => {
	const entries = [
		message("old-relevant", "alpha appears here and gamma appears later", "2020-01-01T00:00:00.000Z"),
		message("recent-partial", "alphabet soup", "2025-01-01T00:00:00.000Z"),
		message("old-phrase", "alpha gamma", "2020-01-02T00:00:00.000Z"),
	];
	const result = await invoke({ entries, query: "alpha gamma" });
	const text = resultText(result);
	assert.ok(text.indexOf("old-phrase") < text.indexOf("old-relevant"));
	const partial = resultText(await invoke({ entries, query: "alpha" }));
	assert.ok(partial.indexOf("old-relevant") < partial.indexOf("recent-partial"), partial);
});

test("prefers an exact token over a recent porter-stemmed match", async () => {
	const result = await invoke({
		entries: [
			message("stemmed", "deploying the service", "2025-01-01T00:00:00.000Z"),
			message("exact", "deploy the service", "2020-01-01T00:00:00.000Z"),
		],
		query: "deploy",
	});
	assert.ok(resultText(result).indexOf("exact") < resultText(result).indexOf("stemmed"));
});

test("retains literal path, punctuation, and partial identifier matching", async () => {
	const entries = [
		message("path", "Changed /src/foo_bar.ts today", "2025-01-01T00:00:00.000Z"),
		message("partial", "prefix foo_bar_suffix", "2025-01-01T00:00:00.000Z"),
		message("punctuation", "error code ERR!", "2025-01-01T00:00:00.000Z"),
	];
	assert.match(resultText(await invoke({ entries, query: "/src/foo_bar.ts" })), /path/);
	assert.match(resultText(await invoke({ entries, query: "foo_bar" })), /partial/);
	assert.match(resultText(await invoke({ entries, query: "ERR!" })), /punctuation/);
});

test("searches all current entries and readable ancestors, including an unavailable current file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "recall-"));
	const parent = join(dir, "parent.jsonl");
	await sessionFile(parent, "parent-session", [message("parent-entry", "ancestor-only-value", "2020-01-01T00:00:00.000Z")], parent);
	const result = await invoke({
		file: join(dir, "not-yet-flushed.jsonl"),
		header: { type: "session", id: "live-session", parentSession: parent },
		entries: [message("live-entry", "current value", "2025-01-01T00:00:00.000Z")],
		query: "ancestor-only-value",
	});
	assert.match(resultText(result), /parent-session#parent-entry/);
	assert.equal(result.details.sessions, 2);
});

test("does not search an unrelated session beside the current file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "recall-"));
	const file = join(dir, "current.jsonl");
	await sessionFile(file, "current-session", []);
	await sessionFile(join(dir, "unrelated.jsonl"), "unrelated-session", [message("secret", "unrelated_probe", "2025-01-01T00:00:00.000Z")]);
	const result = await invoke({ file, entries: [], query: "unrelated_probe" });
	assert.equal(result.details.matches, 0);
	assert.match(resultText(result), /^No matches in this thread/);
});

test("deduplicates copied entries, preserves ancestor branches, and stops cyclic ancestry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "recall-"));
	const parent = join(dir, "parent.jsonl");
	const root = message("root", "cycle-value", "2020-01-01T00:00:00.000Z");
	const branchA = message("branch-a", "ancestor-alpha", "2025-01-01T00:00:00.000Z", "root");
	const branchB = message("branch-b", "ancestor-beta", "2025-01-01T00:00:00.000Z", "root");
	await sessionFile(parent, "parent-session", [root, branchA, branchB], parent);
	const copiedRoot = { ...root };
	const current = message("current", "live", "2025-01-02T00:00:00.000Z", "root");
	const options = {
		file: join(dir, "current.jsonl"),
		header: { type: "session", id: "current-session", parentSession: parent },
		entries: [copiedRoot, current],
	};
	const result = await invoke({ ...options, query: "cycle-value" });
	assert.equal(result.details.matches, 1);
	assert.equal((await invoke({ ...options, query: "alpha" })).details.matches, 1);
	assert.equal((await invoke({ ...options, query: "beta" })).details.matches, 1);
});

test("includes compaction and tool text while skipping thinking and tool calls", async () => {
	const entries = [
		{ type: "compaction", id: "compact", parentId: null, timestamp: "2020-01-01T00:00:00.000Z", summary: "compaction-retained" },
		message("thinking", "", "2020-01-01T00:00:00.000Z", null, [{ type: "thinking", thinking: "private-thinking" }]),
		{ type: "message", id: "tool", timestamp: "2020-01-01T00:00:00.000Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tool-retained" }] } },
		message("call", "", "2020-01-01T00:00:00.000Z", null, [{ type: "toolCall", name: "ignored-call" }]),
	];
	assert.match(resultText(await invoke({ entries, query: "compaction-retained" })), /compact/);
	assert.match(resultText(await invoke({ entries, query: "tool-retained" })), /tool:bash/);
	assert.equal((await invoke({ entries, query: "private-thinking" })).details.matches, 0);
	assert.equal((await invoke({ entries, query: "ignored-call" })).details.matches, 0);
});

test("reports one shown match and one omitted notice for a limit of one", async () => {
	const entries = [
		message("first", "exactly-one-omitted", "2025-01-01T00:00:00.000Z"),
		message("second", "exactly-one-omitted", "2025-01-02T00:00:00.000Z"),
	];
	const result = await invoke({ entries, query: "exactly-one-omitted", limit: 1 });
	assert.equal(result.details.matches, 2);
	assert.equal(result.details.shown, 1);
	assert.match(resultText(result), /\(1 further match not shown; narrow the query\)/);
});

test("clamps positive fractional limits to one match", async () => {
	const entries = [
		message("first", "fractional-limit", "2025-01-01T00:00:00.000Z"),
		message("second", "fractional-limit", "2025-01-02T00:00:00.000Z"),
	];
	const result = await invoke({ entries, query: "fractional-limit", limit: 0.5 });
	assert.equal(result.details.matches, 2);
	assert.equal(result.details.shown, 1);
});

test("keeps the complete rendered result within the cap and reports shown counts", async () => {
	const entries = Array.from({ length: 20 }, (_, index) => message(`entry-${index}`, `cap-term ${"x".repeat(800)}`, "2025-01-01T00:00:00.000Z"));
	const result = await invoke({ entries, query: "cap-term", limit: 20 });
	assert.ok(resultText(result).length <= 6000);
	assert.equal(result.details.matches, 20);
	assert.ok(result.details.shown < result.details.matches);
	assert.equal((resultText(result).match(/^\[/gm) ?? []).length, result.details.shown);
	assert.ok(resultText(result).endsWith(`(${20 - result.details.shown} further matches not shown; narrow the query)`));
});

test("uses the default limit for empty-or-invalid limits and rejects an empty query", async () => {
	const entries = Array.from({ length: 12 }, (_, index) => message(`entry-${index}`, "limit-term", "2025-01-01T00:00:00.000Z"));
	const result = await invoke({ entries, query: "limit-term", limit: 0 });
	assert.equal(result.details.matches, 12);
	assert.equal(result.details.shown, 10);
	const invalid = await invoke({ entries, query: "" });
	assert.match(resultText(invalid), /non-empty query/);
});
