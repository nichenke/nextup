import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import {
	DEGRADED_PREFIX,
	type Answer,
	answerJson,
	readCaveats,
	renderAnswer,
	renderSelection,
	selectionJson,
} from "./selection-output";
import { type Selection, select } from "./selector";
import { deadlockLines, sentinelLines } from "./test-support";
import { type Ticket, ticketId } from "./ticket";
import { type TicketRef, githubTicketRef } from "./ticket-ref";
import type { ReadDegrade } from "./ticket-set-read";

interface Spec {
	readonly key: string;
	readonly title?: string;
	readonly state?: "open" | "closed";
	readonly blockers?: readonly string[] | "unknown";
	readonly labels?: readonly string[];
	readonly url?: string | null;
}

function refOf(key: string): TicketRef {
	return githubTicketRef("example/repo", key);
}

function selectionOf(
	specs: readonly Spec[],
	truncated = false,
	openOnly = false,
	filter: LabelFilterSpec = DEFAULT_LABEL_FILTER,
): Selection {
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
	return select({ tickets, graph, filter: compileLabelFilter(filter), truncated, openOnly });
}

describe("selectionJson", () => {
	test("survives a round trip through JSON, with every reference as its short form", () => {
		const json = selectionJson(selectionOf([{ key: "2", labels: ["P0"] }, { key: "1" }]));
		expect(JSON.parse(JSON.stringify(json))).toEqual(json);
		expect(json.pick?.ref).toBe("gh:example/repo#2");
		expect(json.decision).toEqual({ kind: "rung", rung: "priority", over: "gh:example/repo#1" });
		expect(json.ranked.map((candidate) => candidate.ref)).toEqual(["gh:example/repo#2", "gh:example/repo#1"]);
	});

	test("carries the signals each rung read, so a pick can be argued with", () => {
		const json = selectionJson(selectionOf([{ key: "1", labels: ["P1"] }, { key: "2", blockers: ["1"] }]));
		expect(json.pick).toEqual({
			ref: "gh:example/repo#1",
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

	test("carries each deadlock as its cycle in short form", () => {
		const json = selectionJson(selectionOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(json.deadlocks).toEqual([{ cycle: ["gh:example/repo#1", "gh:example/repo#2"] }]);
		expect(selectionJson(selectionOf([{ key: "1" }])).deadlocks).toEqual([]);
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
		expect(text).toContain("gh:example/repo#2 — Ticket 2");
		expect(text).toContain("won on priority over gh:example/repo#1");
	});

	test("says when there was nothing to compare the pick against", () => {
		expect(renderSelection(selectionOf([{ key: "1" }]))).toContain("the only candidate");
	});

	test("scopes a lone pick when others were held back as unknown", () => {
		const text = renderSelection(
			selectionOf([
				{ key: "1" },
				{ key: "2", blockers: "unknown" },
				{ key: "3", blockers: "unknown" },
			]),
		);
		expect(text).toContain("the only candidate the ladder ranked");
		expect(text).toContain("2 unknown");
	});

	test("scopes a lone pick when the others were held back as blocked", () => {
		const text = renderSelection(
			selectionOf([
				{ key: "1" },
				{ key: "2", labels: ["wayfinder:decision"] },
				{ key: "3", blockers: ["2"] },
				{ key: "4", blockers: ["2"] },
			]),
		);
		expect(text).toContain("the only candidate the ladder ranked");
		expect(text).toContain("2 blocked");
	});

	test("does not scope a lone pick when nothing was held back", () => {
		const text = renderSelection(selectionOf([{ key: "1" }]));
		expect(text).not.toContain("the ladder ranked");
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

	test("names the cycle on its own greppable line when nothing can ever unblock", () => {
		const text = renderSelection(selectionOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(deadlockLines(text)).toEqual([
			"deadlock: gh:example/repo#1 blocked by gh:example/repo#2 blocked by gh:example/repo#1, so nothing in it can ever unblock",
		]);
	});

	test("names a self-blocking ticket as the one-member case", () => {
		expect(deadlockLines(renderSelection(selectionOf([{ key: "1", blockers: ["1"] }])))).toEqual([
			"deadlock: gh:example/repo#1 blocked by gh:example/repo#1, so nothing in it can ever unblock",
		]);
	});

	test("reports the deadlock beside the pick, not instead of it", () => {
		const text = renderSelection(
			selectionOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }, { key: "3" }]),
		);
		expect(text).toContain("gh:example/repo#3 — Ticket 3");
		expect(deadlockLines(text)).toHaveLength(1);
	});

	test("carries no deadlock line for a ticket set that merely waits on open work", () => {
		expect(deadlockLines(renderSelection(selectionOf([{ key: "1" }, { key: "2", blockers: ["1"] }])))).toEqual([]);
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

	// A count on its own leaves a user whose ticket is missing nothing to look up, and the exclusions are a
	// floor no flag mentioned, so the run has to name the ones it applied.
	test("names the exclusions beside the count of what they dropped", () => {
		const text = renderSelection(selectionOf([{ key: "1" }, { key: "2", labels: ["needs-triage"] }]));
		expect(text).toContain("1 filtered out (excluding wayfinder:*, needs-triage, spec)");
	});

	// A ticket dropped for lacking an included label counts as filtered too, so naming only the exclusions
	// blames a pattern that had nothing to do with it.
	test("names an included label as well, since it filters just as much", () => {
		const text = renderSelection(
			selectionOf([{ key: "1", labels: ["backend"] }, { key: "2" }], false, false, {
				include: ["backend"],
				exclude: ["wayfinder:*"],
			}),
		);
		expect(text).toContain("1 filtered out (including backend; excluding wayfinder:*)");
	});

	test("says nothing about exclusions where the filter carries none", () => {
		const text = renderSelection(selectionOf([{ key: "1" }], false, false, { include: [], exclude: [] }));
		expect(text).toContain("0 filtered out,");
	});

	test("counts the closed tickets of a set that was read with them", () => {
		expect(renderSelection(selectionOf([{ key: "1" }, { key: "2", state: "closed" }]))).toContain("1 closed");
	});

	test("says the closed count was not asked for, rather than rendering a zero as a count", () => {
		const text = renderSelection(selectionOf([{ key: "1" }], false, true));
		expect(text).toContain("1 tickets: closed not asked, 0 claimed");
		expect(text).not.toContain("0 closed");
	});
});

describe("renderAnswer", () => {
	const REF: TicketRef = { tracker: "github", repo: "example/repo", key: "4" };

	function answerOf(readDegraded: readonly ReadDegrade[], specs: readonly Spec[] = [{ key: "1" }]): Answer {
		return { selection: selectionOf(specs), readDegraded };
	}

	test("words every kind the read reports, under the same sentinel as the selector's own", () => {
		const text = renderAnswer(
			answerOf([
				{ kind: "outage", detail: "could not resolve host" },
				{ kind: "unreadable-blocking", tickets: 2, of: 9 },
				{ kind: "partial-blocking", refs: [REF] },
				{ kind: "contradicted-blocker", refs: [REF] },
			]),
		);
		const lines = sentinelLines(text);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("could not resolve host");
		expect(lines[1]).toContain("2 of 9 rows read");
		// The whole clause rather than a substring of it: the shorter assertion holds over wordings that say something
		// else entirely, which is no assertion at all about what ADR-0037 depends on.
		expect(lines[2]).toContain("only a page of their blockers arrived, so nothing confirms them unblocked");
		// And the consequence a set read owns: these tickets were dropped, and nothing else in the answer says so.
		expect(lines[2]).toContain("so they were held out of the answer");
		expect(lines[3]).toContain("disagreed about their state");
		for (const line of lines.slice(2)) expect(line).toContain("gh:example/repo#4");
	});

	test("carries both lists when the selector and the read each have something to report", () => {
		const answer: Answer = {
			selection: selectionOf([{ key: "1", blockers: "unknown" }], true),
			readDegraded: [{ kind: "unreadable-blocking", tickets: 1, of: 1 }],
		};
		expect(sentinelLines(renderAnswer(answer))).toHaveLength(3);
	});

	// A tracker's own message is what an outage carries, and `gh` writes those over two lines: the second one
	// reaching the output unprefixed is a line of tracker text presented as the tool's own.
	test("keeps a reason to one line though the tracker's message ran to several", () => {
		const detail = "error connecting to somewhere.invalid\ncheck your internet connection";
		const lines = sentinelLines(renderAnswer(answerOf([{ kind: "outage", detail }])));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("error connecting to somewhere.invalid check your internet connection");
		expect(renderAnswer(answerOf([{ kind: "outage", detail }])).split("\n").filter((line) => line.includes("check your internet"))).toEqual(lines);
	});

	test("renders exactly the selection when the read answered everything", () => {
		const selection = selectionOf([{ key: "1" }]);
		expect(renderAnswer({ selection, readDegraded: [] })).toBe(renderSelection(selection));
	});
});

describe("answerJson", () => {
	test("carries each read degrade by kind, with its references in short form", () => {
		const json = answerJson({
			selection: selectionOf([{ key: "1" }]),
			readDegraded: [{ kind: "partial-blocking", refs: [{ tracker: "github", repo: "example/repo", key: "4" }] }],
		});
		expect(JSON.parse(JSON.stringify(json))).toEqual(json);
		expect(json.readDegraded).toEqual([{ kind: "partial-blocking", refs: ["gh:example/repo#4"] }]);
		expect(json.selection.pick?.ref).toBe("gh:example/repo#1");
	});
});

describe("readCaveats", () => {
	const PARTIAL: readonly ReadDegrade[] = [{ kind: "partial-blocking", refs: [{ tracker: "github", repo: "example/repo", key: "4" }] }];

	/**
	 * One fact, two consequences. A set read drops such a ticket and that exclusion is the only account of it the
	 * answer gives; a single read returns the one ticket it was asked about, and is about to start it. A shared
	 * sentence naming either consequence is false on the other path, which is what `PartialOutcome` exists for.
	 */
	test("names the exclusion for a read that held the ticket out, and not for one that kept it", () => {
		const [heldOut] = readCaveats(PARTIAL, "held-out");
		const [kept] = readCaveats(PARTIAL, "kept");

		expect(heldOut).toContain("nothing confirms them unblocked");
		expect(heldOut).toContain("held out of the answer");
		expect(kept).toContain("nothing confirms them unblocked");
		expect(kept).not.toContain("held out");
	});
});
