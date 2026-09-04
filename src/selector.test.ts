import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import { SelectionError, type SelectionInput, select } from "./selector";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

interface Spec {
	readonly key: string;
	readonly title?: string;
	readonly state?: "open" | "closed";
	readonly claim?: Claim | null;
	readonly blockers?: readonly string[] | "unknown";
	readonly labels?: readonly string[];
	/** Openness as a *blocker*, where a closed ticket did not meet what depended on it. */
	readonly openness?: boolean | "unknown";
}

function refOf(key: string): TicketRef {
	return { tracker: "markdown", repo: null, host: null, key };
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
	options: { filter?: LabelFilterSpec; truncated?: boolean } = {},
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
	};
}

function pickOf(specs: readonly Spec[], options?: { filter?: LabelFilterSpec; truncated?: boolean }): string | null {
	const pick = select(inputOf(specs, options)).pick;
	return pick === null ? null : formatTicketRef(pick.ref);
}

describe("the candidate set", () => {
	test("recommends the one open, unclaimed ticket", () => {
		const selection = select(inputOf([{ key: "1" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:1");
		expect(selection.decision).toEqual({ kind: "only-candidate" });
		expect(selection.consulted).toBe("confirmed");
	});

	test("never recommends a closed ticket", () => {
		expect(pickOf([{ key: "1", state: "closed" }, { key: "2" }])).toBe("md:2");
	});

	test("never recommends a claimed ticket, whether or not the claimant is recorded", () => {
		expect(pickOf([{ key: "1", claim: { by: "octocat" } }, { key: "2" }])).toBe("md:2");
		expect(pickOf([{ key: "1", claim: { by: null } }, { key: "2" }])).toBe("md:2");
	});

	test("never recommends a ticket the label filter drops", () => {
		expect(
			pickOf([{ key: "1", labels: ["wayfinder:decision"] }, { key: "2" }], { filter: DEFAULT_LABEL_FILTER }),
		).toBe("md:2");
	});

	test("recommends only a ticket carrying an included label, where one is named", () => {
		expect(
			pickOf([{ key: "1" }, { key: "2", labels: ["bug"] }], { filter: { include: ["bug"], exclude: [] } }),
		).toBe("md:2");
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
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:2");
		expect(selection.decision).toEqual({
			kind: "rung",
			rung: "priority",
			over: { tracker: "markdown", repo: null, host: null, key: "1" },
		});
	});

	test("takes a ticket carrying a priority over one carrying none", () => {
		expect(pickOf([{ key: "1" }, { key: "2", labels: ["P3"] }])).toBe("md:2");
	});

	test("falls to the unblocks rung when no candidate carries a priority", () => {
		const selection = select(
			inputOf([{ key: "1" }, { key: "2" }, { key: "3", blockers: ["2"] }, { key: "4", blockers: ["2"] }]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:2");
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
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:2");
	});

	test("falls to the reference rung when priority and unblocks both tie", () => {
		const selection = select(inputOf([{ key: "10" }, { key: "9" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:9");
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
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:1");
		expect(selection.unreadPrioritySignals).toEqual(["priority:high"]);
	});
});

describe("the confirmed and unknown partition", () => {
	test("takes a confirmed-unblocked P1 over an unknown-blocking P0", () => {
		const selection = select(
			inputOf([{ key: "1", labels: ["P0"], blockers: "unknown" }, { key: "2", labels: ["P1"] }]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:2");
		expect(selection.consulted).toBe("confirmed");
		expect(selection.degraded).toEqual([]);
	});

	test("consults the unknown set only when nothing confirmed-unblocked is left, and says so", () => {
		const selection = select(inputOf([{ key: "1", blockers: "unknown" }, { key: "2", blockers: "unknown" }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:1");
		expect(selection.consulted).toBe("unknown");
		expect(selection.pick!.blocked).toBe("unknown");
		expect(selection.degraded).toEqual([{ kind: "unconfirmed-blocking" }]);
	});

	test("ranks the unknown set by the same ladder", () => {
		const selection = select(
			inputOf([
				{ key: "1", blockers: "unknown" },
				{ key: "2", labels: ["P0"], blockers: "unknown" },
			]),
		);
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:2");
	});

	test("holds back a candidate whose blocker closed without meeting the dependency", () => {
		const selection = select(
			inputOf([
				{ key: "1", state: "closed", openness: "unknown" },
				{ key: "2", blockers: ["1"] },
			]),
		);
		expect(selection.consulted).toBe("unknown");
		expect(selection.counts.unconfirmed).toBe(1);
	});

	test("recommends nothing when every candidate is confirmed blocked", () => {
		const selection = select(inputOf([{ key: "1" }, { key: "2", blockers: ["1"], claim: { by: "octocat" } }]));
		expect(formatTicketRef(selection.pick!.ref)).toBe("md:1");

		const deadlocked = select(inputOf([{ key: "1", blockers: ["2"] }, { key: "2", blockers: ["1"] }]));
		expect(deadlocked.pick).toBeNull();
		expect(deadlocked.decision).toBeNull();
		expect(deadlocked.consulted).toBeNull();
		expect(deadlocked.counts.blocked).toBe(2);
	});
});

describe("what the selection reports", () => {
	test("reports a truncated fetch rather than presenting a partial set as complete", () => {
		const selection = select(inputOf([{ key: "1" }], { truncated: true }));
		expect(selection.degraded).toEqual([{ kind: "truncated" }]);
	});

	test("reports both degrades where both apply", () => {
		const selection = select(inputOf([{ key: "1", blockers: "unknown" }], { truncated: true }));
		expect(selection.degraded).toEqual([{ kind: "truncated" }, { kind: "unconfirmed-blocking" }]);
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
			confirmed: 1,
			unconfirmed: 1,
			blocked: 1,
		});
		expect(counts.closed + counts.claimed + counts.filtered + counts.candidates).toBe(counts.tickets);
		expect(counts.confirmed + counts.unconfirmed + counts.blocked).toBe(counts.candidates);
	});

	test("ranks the whole consulted set, not only the winner", () => {
		const selection = select(inputOf([{ key: "2" }, { key: "1" }, { key: "3" }]));
		expect(selection.ranked.map((candidate) => formatTicketRef(candidate.ref))).toEqual(["md:1", "md:2", "md:3"]);
	});
});
