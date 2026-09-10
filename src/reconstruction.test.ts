import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import {
	type CheckResult,
	type ReconstructionInput,
	type TrackerObservation,
	type ReconstructionTracker,
	type Verdict,
	checkReconstruction,
	checkReconstructionTracker,
	heldEverywhere,
} from "./reconstruction";
import { type Ticket, ticketId } from "./ticket";
import type { TicketRef } from "./ticket-ref";
import type { TicketSetRead } from "./ticket-set-read";

const REPO = "example/repo";
const FILTER = compileLabelFilter(DEFAULT_LABEL_FILTER);
/** One address for every ticket: no check reads it, and the guard's allowlist holds this spelling verbatim. */
const ISSUE_URL = "https://example.com/example/repo/issues/1";

function ref(key: string, repo = REPO): TicketRef {
	return { tracker: "github", repo, host: null, key };
}

interface Shape {
	readonly key: string;
	readonly claimed?: boolean;
	readonly labels?: readonly string[];
	/** Each blocker as its key and whether it is open; a key outside `SHAPES` is a blocker outside the set. */
	readonly blockers?: readonly (readonly [string, boolean])[];
}

/**
 * The hand-authored world every case below starts from: a bare frontier ticket, one blocked by an open ticket
 * in the set, one freed by a closed blocker outside it, a claimed one and a filtered one.
 *
 * Authored rather than recorded: every shape here is ours by definition and claims nothing about what a tracker
 * emits, which is the exception CLAUDE.md's fixture provenance rule names.
 */
const SHAPES: readonly Shape[] = [
	{ key: "1" },
	{ key: "2", blockers: [["3", true]] },
	{ key: "3" },
	{ key: "4", blockers: [["9", false]] },
	{ key: "8", claimed: true },
	{ key: "10", labels: ["needs-triage"] },
];

function ticketOf(shape: Shape): Ticket {
	return {
		ref: ref(shape.key),
		title: `ticket ${shape.key}`,
		state: "open",
		claim: shape.claimed === true ? { by: "nichenke" } : null,
		blockers: (shape.blockers ?? []).map(([key]) => ref(key)),
		url: ISSUE_URL,
		labels: shape.labels ?? [],
	};
}

function observationOf(shape: Shape): TrackerObservation {
	return {
		ref: ref(shape.key),
		claimed: shape.claimed === true,
		labels: shape.labels ?? [],
		blockers: (shape.blockers ?? []).map(([key, open]) => ({ ref: ref(key), open })),
	};
}

/** A seed per ticket, plus one per blocker named from outside the set, which is what the read carries. */
function graphOver(tickets: readonly Ticket[], shapes: readonly Shape[]) {
	const own = new Set(tickets.map((ticket) => ticketId(ticket.ref)));
	const outside = new Map<string, boolean>();
	for (const shape of shapes) {
		for (const [key, open] of shape.blockers ?? []) {
			if (!own.has(ticketId(ref(key)))) outside.set(key, open);
		}
	}
	return seedGraph([
		...tickets.map((ticket) => ({
			id: ticketId(ticket.ref),
			parent: null,
			blockers: ticket.blockers === "unknown" ? ("unknown" as const) : ticket.blockers.map(ticketId),
			open: true,
		})),
		...[...outside].map(([key, open]) => ({ id: ticketId(ref(key)), parent: null, blockers: "unknown" as const, open })),
	]);
}

/** The read as the adapter would have produced it. */
function readOf(shapes: readonly Shape[]): TicketSetRead {
	const tickets = shapes.map(ticketOf);
	return { tickets, graph: graphOver(tickets, shapes), truncated: false, openOnly: true, degraded: [] };
}

/** The same tickets read with no blocking field in the response, which is what `readBlind` produces live. */
function blindOf(shapes: readonly Shape[]): TicketSetRead {
	const tickets = shapes.map((shape) => ({ ...ticketOf(shape), blockers: "unknown" as const }));
	return {
		tickets,
		graph: seedGraph(
			tickets.map((ticket) => ({ id: ticketId(ticket.ref), parent: null, blockers: "unknown" as const, open: true })),
		),
		truncated: false,
		openOnly: true,
		degraded: [{ kind: "unreadable-blocking", tickets: tickets.length, of: tickets.length }],
	};
}

function world(shapes: readonly Shape[] = SHAPES): ReconstructionInput {
	return { read: readOf(shapes), blind: blindOf(shapes), observations: shapes.map(observationOf), filter: FILTER };
}

/**
 * The agreeing world with one ticket's blocking unknown to the adapter, which is what a degraded read produces.
 * The graph is rebuilt over the whole shape list so it keeps its seed for any blocker outside the set: rebuilt
 * from the tickets alone, a second ticket goes unknown for a reason the case never asked about.
 */
function unknownBlockingOn(key: string, shapes: readonly Shape[] = SHAPES): ReconstructionInput {
	const input = world(shapes);
	const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === key ? { ...ticket, blockers: "unknown" as const } : ticket));
	return { ...input, read: { ...input.read, tickets, graph: graphOver(tickets, shapes) } };
}

function verdicts(input: ReconstructionInput): Record<string, Verdict> {
	const named: Record<string, Verdict> = {};
	for (const check of checkReconstruction(input).checks) named[check.name] = check.verdict;
	return named;
}

/** One named check with its detail lines joined, so a case can assert on wording without pinning line breaks. */
function checkNamed(input: ReconstructionInput, name: string): Omit<CheckResult, "detail"> & { readonly detail: string } {
	const found = checkReconstruction(input).checks.find((check) => check.name === name);
	if (found === undefined) throw new Error(`no check named ${name}`);
	return { ...found, detail: found.detail.join("; ") };
}

describe("checkReconstruction over an agreeing read", () => {
	test("every check runs and holds", () => {
		expect(verdicts(world())).toEqual({
			"whole-set-read": "held",
			"references-parse": "held",
			"blockers-resolve": "held",
			"counts-reconcile": "held",
			"nothing-blocked-is-recommended": "held",
			"edges-agree": "held",
			"frontier-agrees": "held",
			"claimed-leaves-frontier": "held",
			"closed-blocker-unblocks-its-dependent": "held",
			"blocker-outside-the-set": "held",
			"unknown-blocking-is-not-an-empty-list": "held",
		});
	});

	test("the frontier is the unclaimed, admitted, unblocked tickets, ranked", () => {
		// Ticket 3 leads on the unblocks rung, since ticket 2 is waiting on it.
		expect(checkReconstruction(world()).frontier.map((one) => one.key)).toEqual(["3", "1", "4"]);
	});

	test("a passing check names what it read, so a pass cannot be a check that met nothing", () => {
		for (const check of checkReconstruction(world()).checks) {
			expect(check.detail).not.toBeEmpty();
			expect(check.detail.every((detail) => detail !== "")).toBe(true);
		}
	});
});

describe("whole-set-read", () => {
	test("fails a read that stopped short of the ticket set", () => {
		const input = world();
		expect(checkNamed({ ...input, read: { ...input.read, truncated: true } }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("stopped short"),
		});
	});

	test("fails a read whose call did not complete, since there is no window to compare", () => {
		const input = world();
		const degraded = { ...input.read, degraded: [{ kind: "outage", detail: "could not resolve host" }] as const };
		expect(checkNamed({ ...input, read: degraded }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the read did not complete: could not resolve host"),
		});
	});

	test("fails a blocking-field-less read that stopped short, even where it returned the same tickets", () => {
		const input = world();
		expect(checkNamed({ ...input, blind: { ...input.blind, truncated: true } }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the blocking-field-less read stopped short"),
		});
	});

	test("names a contradicted blocker without faulting on it, since a healthy adapter reports one", () => {
		const input = world();
		const degraded = { ...input.read, degraded: [{ kind: "contradicted-blocker", refs: [ref("9")] }] as const };
		expect(checkNamed({ ...input, read: degraded }, "whole-set-read")).toMatchObject({
			verdict: "held",
			detail: expect.stringContaining("degraded: contradicted-blocker"),
		});
	});

	test("fails a read that did not ask for open tickets only", () => {
		const input = world();
		expect(checkNamed({ ...input, read: { ...input.read, openOnly: false } }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("open tickets only"),
		});
	});

	test("fails when the read returned a ticket the tracker did not observe open", () => {
		const input = world();
		expect(checkNamed({ ...input, observations: input.observations.slice(1) }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the read returned gh:example/repo#1, which was not observed open"),
		});
	});

	test("fails when the tracker observed a ticket the read did not return", () => {
		const input = world();
		const read = { ...input.read, tickets: input.read.tickets.slice(1) };
		expect(checkNamed({ ...input, read }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("gh:example/repo#1 was observed open and the read did not return it"),
		});
	});

	test("fails two sides holding different tickets in the same number, which comparing the counts accepted", () => {
		const input = world();
		// A claimed ticket on each side and not the same one: every count balances, and a claim keeps both off
		// either frontier, so no check below has anything left to disagree about.
		const observations = input.observations.map((one) => (one.ref.key === "8" ? { ...one, ref: ref("100") } : one));
		const check = checkNamed({ ...input, observations }, "whole-set-read");
		expect(check.verdict).toBe("failed");
		expect(check.detail).toContain("gh:example/repo#100 was observed open and the read did not return it");
		expect(check.detail).toContain("the read returned gh:example/repo#8, which was not observed open");
	});

	test("fails when the blocking-field-less read did not return a ticket the read met", () => {
		const input = world();
		expect(checkNamed({ ...input, blind: { ...input.blind, tickets: input.blind.tickets.slice(1) } }, "whole-set-read")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the blocking-field-less read did not return gh:example/repo#1"),
		});
	});

	test("reports a ticket held out for paging blockers as the one degrade it is, on neither side as a missing ticket", () => {
		const input = world();
		const withheld = input.read.tickets.find((ticket) => ticket.ref.key === "4")!;
		const read = {
			...input.read,
			tickets: input.read.tickets.filter((ticket) => ticket.ref.key !== "4"),
			degraded: [{ kind: "partial-blocking", refs: [withheld.ref] }] as const,
		};
		const check = checkNamed({ ...input, read }, "whole-set-read");
		expect(check.verdict).toBe("held");
		expect(check.detail).toContain("degraded: partial-blocking");
		expect(check.detail).not.toContain("#4 was observed open and the read did not return it");
		expect(check.detail).not.toContain("the blocking-field-less read returned");
	});
});

describe("references-parse", () => {
	test("fails a reference this tool's own parser will not take back", () => {
		const input = world();
		// Three path segments: `isValidRepoPath` refuses it for GitHub, so the short form does not resolve.
		const tickets = [{ ...ticketOf({ key: "1" }), ref: ref("1", "owner/repo/extra") }, ...input.read.tickets.slice(1)];
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "references-parse")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("did not re-parse"),
		});
	});
});

describe("blockers-resolve", () => {
	test("fails when an edge names a blocker the read left with no state", () => {
		const input = world();
		// The graph without its outside seeds: ticket 4's closed blocker then has no openness at all.
		const graph = seedGraph(
			input.read.tickets.map((ticket) => ({
				id: ticketId(ticket.ref),
				parent: null,
				blockers: ticket.blockers === "unknown" ? ("unknown" as const) : ticket.blockers.map(ticketId),
				open: true,
			})),
		);
		expect(checkNamed({ ...input, read: { ...input.read, graph } }, "blockers-resolve")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("left with no state"),
		});
	});

	test("accepts a blocker the read reported contradicted, which is a state rather than an absence", () => {
		const input = world();
		const graph = seedGraph([
			...input.read.tickets.map((ticket) => ({
				id: ticketId(ticket.ref),
				parent: null,
				blockers: ticket.blockers === "unknown" ? ("unknown" as const) : ticket.blockers.map(ticketId),
				open: true,
			})),
			{ id: ticketId(ref("9")), parent: null, blockers: "unknown" as const, open: "unknown" as const },
		]);
		const read = { ...input.read, graph, degraded: [{ kind: "contradicted-blocker", refs: [ref("9")] }] as const };
		expect(checkNamed({ ...input, read }, "blockers-resolve")).toMatchObject({ verdict: "held" });
	});

	test("is unexercised by a ticket set with no edges at all", () => {
		expect(verdicts(world([{ key: "1" }, { key: "2" }]))["blockers-resolve"]).toBe("unexercised");
	});
});

describe("counts-reconcile", () => {
	test("fails when the answer counted a claim the tracker does not report", () => {
		const input = world();
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "8" ? { ...ticket, claim: null } : ticket));
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "counts-reconcile")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("counted 0 tickets claimed where the tracker reports 1"),
		});
	});

	test("fails when the answer held back a different number of tickets than the tracker's labels call for", () => {
		const input = world();
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "10" ? { ...ticket, labels: ["enhancement"] } : ticket));
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "counts-reconcile")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("held 0 tickets back by label where the tracker's own labels call for 1"),
		});
	});

	test("leaves a ticket held out for paging blockers to whole-set-read, counting it on neither side", () => {
		const input = world();
		const withheld = input.read.tickets.find((ticket) => ticket.ref.key === "8")!;
		const read = {
			...input.read,
			tickets: input.read.tickets.filter((ticket) => ticket.ref.key !== "8"),
			degraded: [{ kind: "partial-blocking", refs: [withheld.ref] }] as const,
		};
		expect(checkNamed({ ...input, read }, "counts-reconcile")).toMatchObject({ verdict: "held" });
	});
});

describe("nothing-blocked-is-recommended", () => {
	test("fails when the tracker says a ranked ticket waits on something still open", () => {
		const input = world();
		// The adapter read ticket 1 as unblocked; the tracker says it waits on an open ticket 7.
		const observations = input.observations.map((one) =>
			one.ref.key === "1" ? { ...one, blockers: [{ ref: ref("7"), open: true }] } : one,
		);
		expect(checkNamed({ ...input, observations }, "nothing-blocked-is-recommended")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("waits on"),
		});
	});

	test("fails when a ranked ticket is not among the tickets the tracker reported open", () => {
		const input = world();
		const observations = input.observations.filter((one) => one.ref.key !== "1");
		expect(checkNamed({ ...input, observations }, "nothing-blocked-is-recommended")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("did not report it"),
		});
	});
});

describe("edges-agree", () => {
	test("fails when the read names a blocker the tracker does not", () => {
		const input = world();
		const observations = input.observations.map((one) => (one.ref.key === "2" ? { ...one, blockers: [] } : one));
		expect(checkNamed({ ...input, observations }, "edges-agree")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the read says gh:example/repo#2 is blocked by gh:example/repo#3 and the tracker does not"),
		});
	});

	test("fails when the tracker names a blocker the read does not", () => {
		const input = world();
		const observations = input.observations.map((one) =>
			one.ref.key === "1" ? { ...one, blockers: [{ ref: ref("9"), open: false }] } : one,
		);
		expect(checkNamed({ ...input, observations }, "edges-agree")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("the tracker says gh:example/repo#1 is blocked by gh:example/repo#9 and the read does not"),
		});
	});

	test("fails when the two sides disagree about whether a blocker is open", () => {
		const input = world();
		const observations = input.observations.map((one) =>
			one.ref.key === "4" ? { ...one, blockers: [{ ref: ref("9"), open: true }] } : one,
		);
		expect(checkNamed({ ...input, observations }, "edges-agree")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("is closed to the read and open to the tracker"),
		});
	});

	/**
	 * The gap this check exists for: both sides lose the same edge, so every check comparing outcomes agrees. The
	 * frontier is identical on both sides here, and only an input comparison sees it.
	 */
	test("sees an edge both sides lost, which agrees on every derived answer", () => {
		const input = world([{ key: "1" }, { key: "2" }, { key: "4", blockers: [["9", false]] }]);
		expect(checkNamed(input, "frontier-agrees")).toMatchObject({ verdict: "held" });
		const withEdge = {
			...input,
			observations: input.observations.map((one) =>
				one.ref.key === "2" ? { ...one, blockers: [{ ref: ref("3"), open: true }] } : one,
			),
		};
		expect(checkNamed(withEdge, "edges-agree")).toMatchObject({ verdict: "failed" });
	});

	test("is unexercised where neither side reported an edge at all", () => {
		expect(verdicts(world([{ key: "1" }, { key: "2" }]))["edges-agree"]).toBe("unexercised");
	});

	test("counts an edge both sides named once, since that is one edge compared", () => {
		// Two tickets with one matched edge each: two edges, not the four that adding the two sides' sizes gives.
		expect(checkNamed(world(), "edges-agree").detail).toBe("2 edges, agreed on both sides");
	});

	/** The exemption `blockersResolve` and `blockerOutsideTheSet` already make, which this check has to make too. */
	test("does not fault a blocker the read reported contradicted, whose unknown openness is a reported state", () => {
		const input = world();
		const graph = seedGraph([
			...input.read.tickets.map((ticket) => ({
				id: ticketId(ticket.ref),
				parent: null,
				blockers: ticket.blockers === "unknown" ? ("unknown" as const) : ticket.blockers.map(ticketId),
				open: true,
			})),
			{ id: ticketId(ref("9")), parent: null, blockers: "unknown" as const, open: "unknown" as const },
		]);
		const read = { ...input.read, graph, degraded: [{ kind: "contradicted-blocker", refs: [ref("9")] }] as const };
		expect(checkNamed({ ...input, read }, "edges-agree")).toMatchObject({ verdict: "held" });
	});
});

describe("frontier-agrees", () => {
	test("fails when the tracker has a ticket on the frontier that the adapter does not", () => {
		const input = world();
		// The tracker says ticket 2's blocker has closed; the adapter still reads it open.
		const observations = input.observations.map((one) =>
			one.ref.key === "2" ? { ...one, blockers: [{ ref: ref("3"), open: false }] } : one,
		);
		expect(checkNamed({ ...input, observations }, "frontier-agrees")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("on the tracker's frontier and not on the adapter's"),
		});
	});

	test("fails when the adapter has a ticket on the frontier that the tracker does not", () => {
		const input = world();
		const observations = input.observations.map((one) =>
			one.ref.key === "1" ? { ...one, blockers: [{ ref: ref("3"), open: true }] } : one,
		);
		expect(checkNamed({ ...input, observations }, "frontier-agrees")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("on the adapter's frontier and not on the tracker's"),
		});
	});

	test("refuses to compare a frontier the adapter could not judge whole", () => {
		// Ticket 2's blocking is unknown to the adapter, and the tracker says it waits on an open blocker — so the
		// tracker keeps it off its frontier too, and the two sides agree on every ticket either of them placed.
		const input = unknownBlockingOn("2");
		const check = checkNamed(input, "frontier-agrees");
		expect(check).toMatchObject({ verdict: "unexercised", detail: expect.stringContaining("unknown blocking") });
	});

	test("reports the disagreement, not the refusal, where the two also differ on a ticket they could compare", () => {
		const input = unknownBlockingOn("2");
		const observations = input.observations.map((one) =>
			one.ref.key === "1" ? { ...one, blockers: [{ ref: ref("3"), open: true }] } : one,
		);
		const check = checkNamed({ ...input, observations }, "frontier-agrees");
		expect(check.verdict).toBe("failed");
		expect(check.detail).toContain("gh:example/repo#1 is on the adapter's frontier and not on the tracker's");
		expect(check.detail).toContain("cannot be compared whole");
	});

	test("reads labels from the observation, so a label the adapter misread disagrees", () => {
		const input = world();
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "10" ? { ...ticket, labels: ["enhancement"] } : ticket));
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "frontier-agrees")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("gh:example/repo#10 is on the adapter's frontier"),
		});
	});
});

describe("claimed-leaves-frontier", () => {
	test("fails when a claim the tracker reports did not take its ticket off the frontier", () => {
		const input = world();
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "8" ? { ...ticket, claim: null } : ticket));
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "claimed-leaves-frontier")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("is claimed and is on the frontier anyway"),
		});
	});

	test("is unexercised where nothing in the repository is claimed", () => {
		expect(verdicts(world([{ key: "1" }, { key: "2" }]))["claimed-leaves-frontier"]).toBe("unexercised");
	});

	test("is unexercised by a claimed ticket the read withheld, which the answer never placed either", () => {
		const input = world([{ key: "1" }, { key: "8", claimed: true }]);
		const withheld = input.read.tickets.find((ticket) => ticket.ref.key === "8")!;
		const read = {
			...input.read,
			tickets: input.read.tickets.filter((ticket) => ticket.ref.key !== "8"),
			degraded: [{ kind: "partial-blocking", refs: [withheld.ref] }] as const,
		};
		expect(checkNamed({ ...input, read }, "claimed-leaves-frontier")).toMatchObject({ verdict: "unexercised" });
	});

	test("is unexercised by a claimed ticket the read never returned, whose absence the claim did not cause", () => {
		const input = world([{ key: "1" }, { key: "8", claimed: true }]);
		// `whole-set-read` is what reports the missing ticket.
		const read = { ...input.read, tickets: input.read.tickets.filter((ticket) => ticket.ref.key !== "8") };
		expect(checkNamed({ ...input, read }, "claimed-leaves-frontier")).toMatchObject({ verdict: "unexercised" });
	});

	test("is unexercised where the frontier is empty anyway, rather than held over a frontier nothing was kept off", () => {
		// Every candidate came back unknown-blocking, so `select` consulted the unknown partition and the frontier is
		// empty for a reason that has nothing to do with the claim.
		const input = world([{ key: "8", claimed: true }, { key: "1" }]);
		const tickets = input.read.tickets.map((ticket) => ({ ...ticket, blockers: "unknown" as const }));
		const graph = seedGraph(
			tickets.map((ticket) => ({ id: ticketId(ticket.ref), parent: null, blockers: "unknown" as const, open: true })),
		);
		const read = { ...input.read, tickets, graph };
		expect(checkNamed({ ...input, read }, "claimed-leaves-frontier")).toMatchObject({ verdict: "unexercised" });
	});
});

describe("closed-blocker-unblocks-its-dependent", () => {
	test("fails when a ticket waiting only on closed blockers is kept off the frontier", () => {
		const input = world();
		// A label the adapter read and the tracker did not: ticket 4 is filtered out of the answer while the
		// observation still says it is recommendable.
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "4" ? { ...ticket, labels: ["needs-triage"] } : ticket));
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "closed-blocker-unblocks-its-dependent")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("waits only on closed blockers and is off the frontier"),
		});
	});

	test("is unexercised where every such ticket was unrecommendable anyway, rather than held over nothing", () => {
		// The claim is why ticket 4 is off the frontier, so nothing about closed blockers was tested.
		const input = world([{ key: "1" }, { key: "4", claimed: true, blockers: [["9", false]] }]);
		expect(checkNamed(input, "closed-blocker-unblocks-its-dependent")).toMatchObject({ verdict: "unexercised" });
	});

	test("is unexercised where no ticket waits on a closed blocker", () => {
		expect(verdicts(world([{ key: "1" }, { key: "2", blockers: [["1", true]] }]))["closed-blocker-unblocks-its-dependent"]).toBe(
			"unexercised",
		);
	});
});

describe("blocker-outside-the-set", () => {
	test("is unexercised where every blocker came back as a ticket of its own", () => {
		expect(verdicts(world([{ key: "1" }, { key: "2", blockers: [["1", true]] }]))["blocker-outside-the-set"]).toBe("unexercised");
	});

	test("counts the distinct blockers the read met without returning", () => {
		expect(checkNamed(world(), "blocker-outside-the-set").detail).toBe("1 blockers outside the read");
	});

	/**
	 * Coverage only. Whether such a blocker carries a state is `blockers-resolve`'s assertion over every edge, and
	 * this check holding while that one names the blocker is what keeps the two from reporting one defect twice.
	 */
	test("leaves a stateless blocker to blockers-resolve rather than faulting on it too", () => {
		const input = world();
		const graph = seedGraph(
			input.read.tickets.map((ticket) => ({
				id: ticketId(ticket.ref),
				parent: null,
				blockers: ticket.blockers === "unknown" ? ("unknown" as const) : ticket.blockers.map(ticketId),
				open: true,
			})),
		);
		const stripped = { ...input, read: { ...input.read, graph } };
		expect(checkNamed(stripped, "blockers-resolve")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("gh:example/repo#9"),
		});
		expect(checkNamed(stripped, "blocker-outside-the-set")).toMatchObject({ verdict: "held" });
	});
});

describe("unknown-blocking-is-not-an-empty-list", () => {
	test("fails when an absent blocking field came back as no blockers", () => {
		const input = world();
		const tickets = input.blind.tickets.map((ticket) => (ticket.ref.key === "1" ? { ...ticket, blockers: [] } : ticket));
		expect(checkNamed({ ...input, blind: { ...input.blind, tickets } }, "unknown-blocking-is-not-an-empty-list")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("an empty list"),
		});
	});

	test("fails when the read did not say its blocking was unreadable", () => {
		const input = world();
		expect(
			checkNamed({ ...input, blind: { ...input.blind, degraded: [] } }, "unknown-blocking-is-not-an-empty-list"),
		).toMatchObject({ verdict: "failed", detail: expect.stringContaining("did not report unreadable blocking") });
	});

	test("fails when the degrade covers fewer tickets than the read returned", () => {
		const input = world();
		const degraded = [{ kind: "unreadable-blocking", tickets: 1, of: input.blind.tickets.length }] as const;
		expect(
			checkNamed({ ...input, blind: { ...input.blind, degraded } }, "unknown-blocking-is-not-an-empty-list"),
		).toMatchObject({ verdict: "failed", detail: expect.stringContaining("1 of 6") });
	});

	test("fails when a candidate was called confirmed-unblocked with no blocking field to say so", () => {
		const input = world();
		// The collapse itself: an absent field seeded as a confirmed absence of blockers.
		const graph = seedGraph(
			input.blind.tickets.map((ticket) => ({ id: ticketId(ticket.ref), parent: null, blockers: [], open: true })),
		);
		expect(
			checkNamed({ ...input, blind: { ...input.blind, graph } }, "unknown-blocking-is-not-an-empty-list"),
		).toMatchObject({ verdict: "failed", detail: expect.stringContaining("confirmed-unblocked") });
	});
});

describe("checkReconstructionTracker", () => {
	function tracker(shapes: readonly Shape[]): ReconstructionTracker & { readonly limits: number[] } {
		const limits: number[] = [];
		return {
			name: "github",
			limits,
			observe: () => shapes.map(observationOf),
			read: (limit) => {
				limits.push(limit);
				return readOf(shapes);
			},
			readBlind: (limit) => {
				limits.push(limit);
				return blindOf(shapes);
			},
		};
	}

	test("sizes both adapter reads from the independently observed count", () => {
		const one = tracker(SHAPES);
		const report = checkReconstructionTracker(one, FILTER);
		expect(one.limits).toEqual([SHAPES.length, SHAPES.length]);
		expect(report.tracker).toBe("github");
		expect(heldEverywhere(report)).toBe(true);
	});

	test("refuses a repository with no open tickets rather than reporting checks that read nothing", () => {
		expect(() => checkReconstructionTracker(tracker([]), FILTER)).toThrow(/no open tickets/);
	});

	test("an unexercised check is not a pass", () => {
		const report = checkReconstructionTracker(tracker([{ key: "1" }, { key: "2" }]), FILTER);
		expect(report.checks.some((check) => check.verdict === "unexercised")).toBe(true);
		expect(heldEverywhere(report)).toBe(false);
	});
});
