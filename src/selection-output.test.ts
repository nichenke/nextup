import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import { DEGRADED_PREFIX, renderSelection, selectionJson } from "./selection-output";
import { type Selection, select } from "./selector";
import { type Ticket, ticketId } from "./ticket";
import type { TicketRef } from "./ticket-ref";

interface Spec {
	readonly key: string;
	readonly title?: string;
	readonly state?: "open" | "closed";
	readonly blockers?: readonly string[] | "unknown";
	readonly labels?: readonly string[];
	readonly url?: string | null;
}

function refOf(key: string): TicketRef {
	return { tracker: "markdown", repo: null, host: null, key };
}

function selectionOf(specs: readonly Spec[], truncated = false): Selection {
	const tickets: Ticket[] = specs.map((spec) => ({
		ref: refOf(spec.key),
		title: spec.title ?? `Ticket ${spec.key}`,
		state: spec.state ?? "open",
		claim: null,
		blockers: spec.blockers === "unknown" ? "unknown" : (spec.blockers ?? []).map(refOf),
		url: spec.url ?? null,
		labels: spec.labels ?? [],
	}));
	const graph = seedGraph(
		specs.map((spec) => ({
			id: ticketId(refOf(spec.key)),
			parent: null,
			blockers: spec.blockers === "unknown" ? ("unknown" as const) : (spec.blockers ?? []).map((key) => ticketId(refOf(key))),
			open: (spec.state ?? "open") === "open",
		})),
	);
	return select({ tickets, graph, filter: compileLabelFilter(DEFAULT_LABEL_FILTER), truncated });
}

describe("selectionJson", () => {
	test("survives a round trip through JSON, with every reference as its short form", () => {
		const json = selectionJson(selectionOf([{ key: "2", labels: ["P0"] }, { key: "1" }]));
		expect(JSON.parse(JSON.stringify(json))).toEqual(json);
		expect(json.pick?.ref).toBe("md:2");
		expect(json.decision).toEqual({ kind: "rung", rung: "priority", over: "md:1" });
		expect(json.ranked.map((candidate) => candidate.ref)).toEqual(["md:2", "md:1"]);
	});

	test("carries the signals each rung read, so a pick can be argued with", () => {
		const json = selectionJson(selectionOf([{ key: "1", labels: ["P1"] }, { key: "2", blockers: ["1"] }]));
		expect(json.pick).toEqual({
			ref: "md:1",
			title: "Ticket 1",
			url: null,
			labels: ["P1"],
			blocked: "unblocked",
			priority: 1,
			unreadPriority: [],
			unblocks: 1,
		});
	});

	test("names each degrade by kind, so a script can test for one", () => {
		expect(selectionJson(selectionOf([{ key: "1" }], true)).degraded).toEqual(["truncated"]);
		expect(selectionJson(selectionOf([{ key: "1", blockers: "unknown" }])).degraded).toEqual([
			"unknown-blocking",
		]);
	});

	test("reports no pick as null rather than as an omitted key", () => {
		const json = selectionJson(selectionOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(json.pick).toBeNull();
		expect(json.decision).toBeNull();
		expect(json.consulted).toBeNull();
		expect(json.ranked).toEqual([]);
	});

	test("echoes the filter and the counts", () => {
		const json = selectionJson(selectionOf([{ key: "1" }]));
		expect(json.filter).toEqual(DEFAULT_LABEL_FILTER);
		expect(json.counts.tickets).toBe(1);
	});
});

describe("renderSelection", () => {
	test("leads with the pick and why it won", () => {
		const text = renderSelection(selectionOf([{ key: "2", labels: ["P0"] }, { key: "1" }]));
		expect(text).toContain("md:2 — Ticket 2");
		expect(text).toContain("won on priority over md:1");
	});

	test("says when there was nothing to compare the pick against", () => {
		expect(renderSelection(selectionOf([{ key: "1" }]))).toContain("the only candidate");
	});

	// Otherwise the decision line asserts those candidates do not exist while the counts below report
	// them, and the ranking never showed them because it never consulted their partition.
	test("scopes a lone pick to its partition when others were held back", () => {
		const text = renderSelection(
			selectionOf([
				{ key: "1" },
				{ key: "2", blockers: "unknown" },
				{ key: "3", blockers: "unknown" },
			]),
		);
		expect(text).toContain("the only candidate with confirmed blocking");
		expect(text).toContain("2 unknown");
	});

	test("does not scope a lone pick when nothing was held back", () => {
		const text = renderSelection(selectionOf([{ key: "1" }]));
		expect(text).not.toContain("confirmed blocking");
	});

	test("shows the ticket's url where the tracker has one", () => {
		const text = renderSelection(selectionOf([{ key: "1", url: "https://example.com/issues/1" }]));
		expect(text).toContain("https://example.com/issues/1");
	});

	test("carries one greppable sentinel line per degrade", () => {
		const text = renderSelection(selectionOf([{ key: "1", blockers: "unknown" }], true));
		const sentinels = text.split("\n").filter((line) => line.startsWith(DEGRADED_PREFIX));
		expect(sentinels).toHaveLength(2);
		expect(sentinels[0]).toContain("truncated");
		expect(sentinels[1]).toContain("blockers");
	});

	test("carries no sentinel when the answer is a confident one", () => {
		const text = renderSelection(selectionOf([{ key: "1" }]));
		expect(text.split("\n").some((line) => line.startsWith(DEGRADED_PREFIX))).toBe(false);
	});

	test("says plainly when there is nothing to recommend, and still accounts for the tickets", () => {
		const text = renderSelection(selectionOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(text).toContain("no candidate to recommend");
		expect(text).toContain("2 blocked");
	});

	test("names a priority label the ladder did not read, on the candidate that carried it", () => {
		const text = renderSelection(selectionOf([{ key: "1", labels: ["priority:high"] }]));
		expect(text).toContain("priority none (unread: priority:high)");
	});

	test("names an unread label on a candidate whose numeric priority the ladder did read", () => {
		const text = renderSelection(selectionOf([{ key: "1", labels: ["P1", "priority:high"] }]));
		expect(text).toContain("priority P1 (unread: priority:high)");
	});

	test("separates a candidate carrying no priority from one whose priority went unread", () => {
		expect(renderSelection(selectionOf([{ key: "1" }]))).toContain("priority none, unblocks 0");
		expect(renderSelection(selectionOf([{ key: "1", labels: ["priority:high"] }]))).toContain(
			"priority none (unread: priority:high), unblocks 0",
		);
	});

	test("ends with a newline, so it composes with anything reading it a line at a time", () => {
		expect(renderSelection(selectionOf([{ key: "1" }]))).toEndWith("\n");
	});
});
