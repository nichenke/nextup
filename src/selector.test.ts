import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import { type Deadlock, SelectionError, type SelectionInput, select } from "./selector";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

interface Spec {
	readonly key: string;
	readonly title?: string;
	readonly state?: "open" | "closed";
	readonly claim?: Claim | null;
	readonly blockers?: readonly string[] | "unknown";
	readonly labels?: readonly string[];
	/** Openness as a *blocker*; see `GraphSeed.open` for why that differs from `state`. */
	readonly openness?: boolean | "unknown";
}

function refOf(key: string): TicketRef {
	return { tracker: "github", repo: "example/repo", host: null, key };
}

function ticketOf(spec: Spec): Ticket {
	return {
		ref: refOf(spec.key),
		title: spec.title ?? `Ticket ${spec.key}`,
		state: spec.state ?? "open",
		claim: spec.claim ?? null,
		blockers: spec.blockers === "unknown" ? "unknown" : (spec.blockers ?? []).map(refOf),
		url: null,
		labels: spec.labels ?? [],
	};
}

function inputOf(
	specs: readonly Spec[],
	options: { filter?: LabelFilterSpec; truncated?: boolean; openOnly?: boolean } = {},
): SelectionInput {
	const graph = seedGraph(
		specs.map((spec) => ({
			id: ticketId(refOf(spec.key)),
			parent: null,
			blockers: spec.blockers === "unknown" ? ("unknown" as const) : (spec.blockers ?? []).map((key) => ticketId(refOf(key))),
			open: spec.openness ?? (spec.state ?? "open") === "open",
		})),
	);
	return {
		tickets: specs.map(ticketOf),
		graph,
		filter: compileLabelFilter(options.filter ?? { include: [], exclude: [] }),
		truncated: options.truncated ?? false,
		openOnly: options.openOnly ?? false,
	};
}

function pickOf(specs: readonly Spec[], options?: { filter?: LabelFilterSpec; truncated?: boolean }): string | null {
	const pick = select(inputOf(specs, options)).pick;
	return pick === null ? null : formatTicketRef(pick.ref);
}

describe("the candidate set", () => {
	test("recommends the one open, unclaimed ticket", () => {
		const selection = select(inputOf([{ key: "1" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#1");
		expect(selection.decision).toEqual({ kind: "only-candidate" });
		expect(selection.consulted).toBe("unblocked");
	});

	test("never recommends a closed ticket", () => {
		expect(pickOf([{ key: "1", state: "closed" }, { key: "2" }])).toBe("gh:example/repo#2");
	});

	test("never recommends a claimed ticket, whether or not the claimant is recorded", () => {
		expect(pickOf([{ key: "1", claim: { by: "octocat" } }, { key: "2" }])).toBe("gh:example/repo#2");
		expect(pickOf([{ key: "1", claim: { by: null } }, { key: "2" }])).toBe("gh:example/repo#2");
	});

	test("never recommends a ticket the label filter drops", () => {
		expect(
			pickOf([{ key: "1", labels: ["wayfinder:decision"] }, { key: "2" }], { filter: DEFAULT_LABEL_FILTER }),
		).toBe("gh:example/repo#2");
	});

	test("recommends only a ticket carrying an included label, where one is named", () => {
		expect(
			pickOf([{ key: "1" }, { key: "2", labels: ["bug"] }], { filter: { include: ["bug"], exclude: [] } }),
		).toBe("gh:example/repo#2");
	});

	test("reports a candidate blocked solely by an excluded ticket as blocked, not as startable", () => {
		const selection = select(
			inputOf(
				[
					{ key: "1", labels: ["wayfinder:decision"] },
					{ key: "2", blockers: ["1"] },
				],
				{ filter: DEFAULT_LABEL_FILTER },
			),
		);
		expect(selection.pick).toBeNull();
		expect(selection.counts.blocked).toBe(1);
		expect(selection.counts.filtered).toBe(1);
	});

	test("refuses a ticket set in which two tickets share one graph id", () => {
		const input = inputOf([{ key: "1" }]);
		expect(() => select({ ...input, tickets: [...input.tickets, ...input.tickets] })).toThrow(SelectionError);
	});
});

describe("the ranking ladder", () => {
	test("takes the higher priority first, and says which rung decided", () => {
		const selection = select(inputOf([{ key: "1", labels: ["P2"] }, { key: "2", labels: ["P0"] }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#2");
		expect(selection.decision).toEqual({
			kind: "rung",
			rung: "priority",
			over: { tracker: "github", repo: "example/repo", host: null, key: "1" },
		});
	});

	test("takes a ticket carrying a priority over one carrying none", () => {
		expect(pickOf([{ key: "1" }, { key: "2", labels: ["P3"] }])).toBe("gh:example/repo#2");
	});

	test("falls to the unblocks rung when no candidate carries a priority", () => {
		const selection = select(
			inputOf([{ key: "1" }, { key: "2" }, { key: "3", blockers: ["2"] }, { key: "4", blockers: ["2"] }]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#2");
		expect(selection.decision).toMatchObject({ kind: "rung", rung: "unblocks" });
		expect(selection.pick!.unblocks).toBe(2);
	});

	test("counts only the open tickets a candidate unblocks", () => {
		const selection = select(
			inputOf([
				{ key: "1" },
				{ key: "2" },
				{ key: "3", state: "closed", openness: false, blockers: ["1"] },
				{ key: "4", state: "closed", openness: false, blockers: ["1"] },
				{ key: "5", blockers: ["2"] },
			]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#2");
	});

	test("falls to the reference rung when priority and unblocks both tie", () => {
		const selection = select(inputOf([{ key: "10" }, { key: "9" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#9");
		expect(selection.decision).toMatchObject({ kind: "rung", rung: "reference" });
	});

	test("gives the same answer whatever order the tickets arrived in", () => {
		const specs: Spec[] = [{ key: "3" }, { key: "1" }, { key: "2", blockers: ["1"] }];
		const forwards = select(inputOf(specs)).ranked.map((candidate) => formatTicketRef(candidate.ref));
		const backwards = select(inputOf([...specs].reverse())).ranked.map((candidate) => formatTicketRef(candidate.ref));
		expect(forwards).toEqual(backwards);
	});

	test("reports a priority label it could not order rather than ranking on a guess", () => {
		const selection = select(inputOf([{ key: "1", labels: ["priority:high"] }, { key: "2" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#1");
		expect(selection.pick!.unreadPriority).toEqual(["priority:high"]);
	});
});

describe("the confirmed and unknown partition", () => {
	test("takes a confirmed-unblocked P1 over an unknown-blocking P0", () => {
		const selection = select(
			inputOf([{ key: "1", labels: ["P0"], blockers: "unknown" }, { key: "2", labels: ["P1"] }]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#2");
		expect(selection.consulted).toBe("unblocked");
		expect(selection.degraded).toEqual([]);
	});

	test("consults the unknown set only when nothing confirmed-unblocked is left, and says so", () => {
		const selection = select(inputOf([{ key: "1", blockers: "unknown" }, { key: "2", blockers: "unknown" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#1");
		expect(selection.consulted).toBe("unknown");
		expect(selection.pick!.blocked).toBe("unknown");
		expect(selection.degraded).toEqual([{ kind: "unknown-blocking" }]);
	});

	test("ranks the unknown set by the same ladder", () => {
		const selection = select(
			inputOf([
				{ key: "1", blockers: "unknown" },
				{ key: "2", labels: ["P0"], blockers: "unknown" },
			]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#2");
	});

	test("holds back a candidate whose blocker closed without meeting what waited on it", () => {
		const selection = select(
			inputOf([
				{ key: "1", state: "closed", openness: "unknown" },
				{ key: "2", blockers: ["1"] },
			]),
		);
		expect(selection.consulted).toBe("unknown");
		expect(selection.counts.unknown).toBe(1);
	});

	test("recommends nothing when every candidate is confirmed blocked", () => {
		const selection = select(inputOf([{ key: "1" }, { key: "2", blockers: ["1"], claim: { by: "octocat" } }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#1");

		const deadlocked = select(inputOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(deadlocked.pick).toBeNull();
		expect(deadlocked.decision).toBeNull();
		expect(deadlocked.consulted).toBeNull();
		expect(deadlocked.counts.blocked).toBe(2);
	});
});

describe("the deadlock diagnostic", () => {
	function deadlocksOf(specs: readonly Spec[], options?: { filter?: LabelFilterSpec }): string[][] {
		return select(inputOf(specs, options)).deadlocks.map((deadlock) => deadlock.cycle.map(formatTicketRef));
	}

	// The two shapes that both report nothing to recommend, told apart. Every candidate here is blocked by
	// a ticket somebody is working, so the backlog opens up when that ticket closes.
	test("reports no deadlock where every candidate waits on work that can still land", () => {
		const selection = select(
			inputOf([{ key: "1", claim: { by: "octocat" } }, { key: "2", blockers: ["1"] }, { key: "3", blockers: ["1"] }]),
		);
		expect(selection.pick).toBeNull();
		expect(selection.deadlocks).toEqual([]);
	});

	// `bun test` is transpile-only, so the assertion here is `tsc --noEmit`, which CI runs as its own gate: it
	// fails if the directive stops being needed, which is what an empty cycle becoming representable looks
	// like. A deadlock naming no ticket renders as a claim with nothing in it.
	test("cannot represent a cycle that names no ticket", () => {
		// @ts-expect-error an empty cycle is not a Deadlock
		const empty: Deadlock = { cycle: [] };
		expect(empty.cycle).toHaveLength(0);
	});

	test("names the tickets of a cycle nothing can ever unblock", () => {
		const selection = select(inputOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(selection.pick).toBeNull();
		expect(selection.deadlocks.map((deadlock) => deadlock.cycle.map(formatTicketRef))).toEqual([
			["gh:example/repo#1", "gh:example/repo#2"],
		]);
	});

	test("reports a self-blocking ticket as the one-member case", () => {
		expect(deadlocksOf([{ key: "1", blockers: ["1"] }])).toEqual([["gh:example/repo#1"]]);
	});

	test("still recommends and still counts everything, with a deadlock in the set", () => {
		const selection = select(inputOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }, { key: "3" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#3");
		expect(selection.counts.tickets).toBe(3);
		expect(selection.counts.blocked).toBe(2);
		expect(selection.deadlocks).toHaveLength(1);
	});

	test("reports no deadlock for a diamond", () => {
		expect(
			deadlocksOf([{ key: "1", blockers: ["2", "3"] }, { key: "2", blockers: ["4"] }, { key: "3", blockers: ["4"] }, { key: "4" }]),
		).toEqual([]);
	});

	test("reports no deadlock where a member of the cycle is closed, and recommends what it freed", () => {
		const selection = select(
			inputOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["3"], state: "closed" }, { key: "3", blockers: ["1"] }]),
		);
		expect(selection.deadlocks).toEqual([]);
		expect(formatTicketRef(selection.pick!.ref)).toBe("gh:example/repo#1");
	});

	test("names a cycle among tickets the filter dropped", () => {
		expect(
			deadlocksOf(
				[
					{ key: "1", blockers: ["2"], labels: ["wayfinder:decision"] },
					{ key: "2", blockers: ["1"], labels: ["wayfinder:decision"] },
					{ key: "3", blockers: ["1"] },
				],
				{ filter: DEFAULT_LABEL_FILTER },
			),
		).toEqual([["gh:example/repo#1", "gh:example/repo#2"]]);
	});

	test("reports no deadlock where the edge closing the loop was never read", () => {
		expect(deadlocksOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: "unknown" }])).toEqual([]);
	});
});

describe("what the selection reports", () => {
	test("reports a truncated fetch rather than presenting a partial set as complete", () => {
		const selection = select(inputOf([{ key: "1" }], { truncated: true }));
		expect(selection.degraded).toEqual([{ kind: "truncated" }]);
	});

	test("reports both degrades where both apply", () => {
		const selection = select(inputOf([{ key: "1", blockers: "unknown" }], { truncated: true }));
		expect(selection.degraded).toEqual([{ kind: "truncated" }, { kind: "unknown-blocking" }]);
	});

	test("echoes the filter that ran, so an absent ticket can be traced to it", () => {
		const selection = select(inputOf([{ key: "1" }], { filter: DEFAULT_LABEL_FILTER }));
		expect(selection.filter).toEqual(DEFAULT_LABEL_FILTER);
	});

	test("counts every ticket exactly once against the reason it was set aside", () => {
		const selection = select(
			inputOf(
				[
					{ key: "1", state: "closed" },
					{ key: "2", claim: { by: "octocat" } },
					{ key: "3", labels: ["wayfinder:decision"] },
					{ key: "4", blockers: ["3"] },
					{ key: "5", blockers: "unknown" },
					{ key: "6" },
				],
				{ filter: DEFAULT_LABEL_FILTER },
			),
		);
		const counts = selection.counts;
		expect(counts).toEqual({
			tickets: 6,
			closed: 1,
			claimed: 1,
			filtered: 1,
			candidates: 3,
			unblocked: 1,
			unknown: 1,
			blocked: 1,
		});
		// Refuses the sentinel rather than defaulting it to zero, which is a total that means something else.
		if (counts.closed === "not-asked") throw new Error("a set read with closed tickets must report a count");
		expect(counts.closed + counts.claimed + counts.filtered + counts.candidates).toBe(counts.tickets);
		expect(counts.unblocked + counts.unknown + counts.blocked).toBe(counts.candidates);
	});

	test("says the closed count was not asked for, rather than reporting a zero as a count", () => {
		const counts = select(inputOf([{ key: "1" }, { key: "2", claim: { by: "octocat" } }], { openOnly: true })).counts;
		expect(counts.closed).toBe("not-asked");
		expect(counts.tickets).toBe(2);
		expect(counts.claimed).toBe(1);
		// The same identity in the form this read shape admits, with nothing for `closed` to contribute.
		expect(counts.claimed + counts.filtered + counts.candidates).toBe(counts.tickets);
	});

	test("still counts the closed tickets of a set that was read with them", () => {
		expect(select(inputOf([{ key: "1", state: "closed" }, { key: "2" }])).counts.closed).toBe(1);
	});

	test("refuses a closed ticket in a set read as open tickets only, rather than denying it in the counts", () => {
		expect(() => select(inputOf([{ key: "1", state: "closed" }], { openOnly: true }))).toThrow(SelectionError);
	});

	test("ranks the whole consulted set, not only the winner", () => {
		const selection = select(inputOf([{ key: "2" }, { key: "1" }, { key: "3" }]));
		expect(selection.ranked.map((candidate) => formatTicketRef(candidate.ref))).toEqual(["gh:example/repo#1", "gh:example/repo#2", "gh:example/repo#3"]);
	});
});
