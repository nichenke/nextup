import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import {
	type CheckResult,
	type NamedRead,
	type ReconstructionInput,
	type TrackerObservation,
	type ReconstructionTracker,
	type Verdict,
	checkReconstruction,
	checkReconstructionTracker,
	heldEverywhere,
} from "./reconstruction";
import { type Ticket, ticketId } from "./ticket";
import { type TicketRef, githubTicketRef, gitlabTicketRef } from "./ticket-ref";
import { type TicketRead, type TicketSetRead, ticketRead } from "./ticket-set-read";

const REPO = "example/repo";
const FILTER = compileLabelFilter(DEFAULT_LABEL_FILTER);
/** One address for every ticket: no check reads it, and the guard's allowlist holds this spelling verbatim. */
const ISSUE_URL = "https://example.com/example/repo/issues/1";

function ref(key: string, repo = REPO): TicketRef {
	return githubTicketRef(repo, key);
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
	return {
		read: readOf(shapes),
		blind: blindOf(shapes),
		observations: shapes.map(observationOf),
		filter: FILTER,
		named: namedWorld(shapes),
	};
}

/**
 * One ticket of the world as the tracker's single-ticket surface would answer about it: the shape's own ticket,
 * and a seed per blocker carrying the openness that shape's edge claims. Built from the same shapes, so an
 * agreeing world agrees here too and a case has to say what it wants to differ.
 */
function namedTicketReadOf(shapes: readonly Shape[], key: string, overrides: Partial<Ticket> = {}): TicketRead {
	const shape = shapes.find((one) => one.key === key);
	if (shape === undefined) throw new Error(`no shape is keyed ${key}`);
	return ticketRead({
		ticket: { ...ticketOf(shape), ...overrides },
		blockers: (shape.blockers ?? []).map(([blockerKey, open]) => ({ ref: ref(blockerKey), open })),
		degraded: [],
	});
}

function namedReadOf(shapes: readonly Shape[], key: string, overrides: Partial<Ticket> = {}): NamedRead {
	return { kind: "read", ref: ref(key), read: namedTicketReadOf(shapes, key, overrides) };
}

/**
 * A blocker the set read met only as an edge, read on its own: closed, and with no blockers of its own read.
 *
 * This is the shape the single read exists for — ADR-0028 keeps a closed ticket out of the set read, so the only
 * way one is ever answered about is a call like this.
 */
function closedTicketReadOf(key: string): TicketRead {
	return {
		...ticketRead({ ticket: { ...ticketOf({ key }), state: "closed" }, blockers: [], degraded: [] }),
	};
}

/**
 * The two single-ticket reads an agreeing world answers with: its lowest-referenced open ticket, and the closed
 * blocker outside it. Chosen the way `namedReads` chooses, so the default world exercises both checks rather than
 * leaving them unexercised — a world that agrees everywhere has to agree here too.
 */
function namedWorld(shapes: readonly Shape[]): { open: NamedRead | null; closed: NamedRead | null } {
	const keys = [...shapes].map((shape) => shape.key).sort();
	const own = new Set(keys);
	const closedOutside = shapes
		.flatMap((shape) => shape.blockers ?? [])
		.filter(([key, open]) => !own.has(key) && !open)
		.map(([key]) => key)
		.sort();
	const open = keys[0];
	const closed = closedOutside[0];
	return {
		open: open === undefined ? null : namedReadOf(shapes, open),
		closed: closed === undefined ? null : { kind: "read", ref: ref(closed), read: closedTicketReadOf(closed) },
	};
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
			"named-ticket-agrees-with-the-set": "held",
			"named-ticket-answers-about-a-closed-one": "held",
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
	// A GitLab reference that knows its host, which `formatTicketRef` deliberately drops: the short form has
	// nowhere to carry one, so the printed reference parses back as a different node.
	test("fails a reference this tool's own parser does not take back to the same ticket", () => {
		const input = world();
		const elsewhere = gitlabTicketRef("group/project", "example.com", "1");
		const tickets = [{ ...ticketOf({ key: "1" }), ref: elsewhere }, ...input.read.tickets.slice(1)];
		expect(checkNamed({ ...input, read: { ...input.read, tickets } }, "references-parse")).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("re-parsed as"),
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

	test("fails a label swapped between two blocked tickets, which leaves every bucket the same size", () => {
		const shapes = [...SHAPES, { key: "100", blockers: [["3", true]] as const, labels: ["needs-triage"] }];
		const input = world(shapes);
		// Neither ticket reaches a frontier on either side, and no other check reads a label, so the totals were
		// the only thing standing between this and a green run.
		const tickets = input.read.tickets.map((ticket) =>
			ticket.ref.key === "100" ? { ...ticket, labels: [] } : ticket.ref.key === "2" ? { ...ticket, labels: ["needs-triage"] } : ticket,
		);
		const check = checkNamed({ ...input, read: { ...input.read, tickets } }, "counts-reconcile");
		expect(check.verdict).toBe("failed");
		expect(check.detail).toContain("gh:example/repo#2 was read as filtered where the tracker's own claim and labels call for a candidate");
		expect(check.detail).toContain("gh:example/repo#100 was read as a candidate where the tracker's own claim and labels call for filtered");
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

	test("refuses to compare when the read lost a blocking field on a ticket it placed by claim before blocking", () => {
		const input = world();
		// Ticket 8 is claimed, so `place` never asks about its blocking and `counts.unknown` stays zero. Every check
		// held over this: both frontiers exclude the ticket for the claim, and edges-agree skips it.
		const tickets = input.read.tickets.map((ticket) => (ticket.ref.key === "8" ? { ...ticket, blockers: "unknown" as const } : ticket));
		const read = {
			...input.read,
			tickets,
			graph: graphOver(tickets, SHAPES),
			degraded: [{ kind: "unreadable-blocking", tickets: 1, of: tickets.length }] as const,
		};
		expect(checkNamed({ ...input, read }, "frontier-agrees")).toMatchObject({
			verdict: "unexercised",
			detail: expect.stringContaining("the read could not read blocking for 1 tickets"),
		});
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
			// Falls back to the closed form for a key no shape describes, which is how a live tracker answers about a
			// blocker the set read met only as an edge.
			readNamed: (named) =>
				shapes.some((shape) => shape.key === named.key) ? namedTicketReadOf(shapes, named.key) : closedTicketReadOf(named.key),
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

describe("named-ticket-agrees-with-the-set", () => {
	const NAME = "named-ticket-agrees-with-the-set";

	test("is unexercised where no ticket was read on its own", () => {
		expect(checkNamed({ ...world(), named: { open: null, closed: null } }, NAME)).toMatchObject({ verdict: "unexercised" });
	});

	test("fails when the two surfaces disagree about the ticket itself", () => {
		const input = world();
		const open = namedReadOf(SHAPES, "1", { title: "a different title" });
		expect(checkNamed({ ...input, named: { ...input.named, open } }, NAME)).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("is titled"),
		});
	});

	test("fails when the single read calls startable a ticket the set read knows is blocked", () => {
		const input = world();
		// Ticket 2 waits on an open ticket in the set. Read alone with its edges unreadable it derives `unknown`,
		// which the override path would start — the one direction of disagreement that matters.
		const open = namedReadOf(SHAPES, "2", { blockers: "unknown" });
		expect(checkNamed({ ...input, named: { ...input.named, open } }, NAME)).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("would start blocked work"),
		});
	});

	/**
	 * The other direction is expected rather than wrong: a single read knows only this ticket's edges, and ADR-0027
	 * allows an edge to be staler than the row it copies. Faulting on it would make the check cry wolf on exactly
	 * the staleness the set read's row-over-edge precedence exists to absorb.
	 */
	test("holds when the single read is the more cautious of the two", () => {
		const input = world();
		const cautious: NamedRead = {
			kind: "read",
			ref: ref("4"),
			read: ticketRead({ ticket: ticketOf({ key: "4", blockers: [["9", false]] }), blockers: [{ ref: ref("9"), open: true }], degraded: [] }),
		};
		expect(checkNamed({ ...input, named: { ...input.named, open: cautious } }, NAME)).toMatchObject({ verdict: "held" });
	});

	test("fails when the ticket the set read named cannot be read on its own", () => {
		const input = world();
		const failed: NamedRead = { kind: "failed", ref: ref("1"), why: "the tracker could not be reached" };
		expect(checkNamed({ ...input, named: { ...input.named, open: failed } }, NAME)).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("failed"),
		});
	});
});

describe("named-ticket-answers-about-a-closed-one", () => {
	const NAME = "named-ticket-answers-about-a-closed-one";

	test("is unexercised where no edge named a closed blocker", () => {
		const input = world([{ key: "1" }, { key: "2", blockers: [["1", true]] }]);
		expect(checkNamed(input, NAME)).toMatchObject({ verdict: "unexercised" });
	});

	// The property ADR-0037 rests on: were the single read to ask for open tickets the way the set read does, a
	// closed ticket would come back absent and the override path would refuse it as one that does not exist.
	test("fails when a closed blocker comes back open read on its own", () => {
		const input = world();
		const closed: NamedRead = {
			kind: "read",
			ref: ref("9"),
			read: ticketRead({ ticket: ticketOf({ key: "9" }), blockers: [], degraded: [] }),
		};
		expect(checkNamed({ ...input, named: { ...input.named, closed } }, NAME)).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("came back open"),
		});
	});

	test("fails when the closed blocker cannot be read at all", () => {
		const input = world();
		const failed: NamedRead = { kind: "failed", ref: ref("9"), why: "no issue found" };
		expect(checkNamed({ ...input, named: { ...input.named, closed: failed } }, NAME)).toMatchObject({
			verdict: "failed",
			detail: expect.stringContaining("refused as closed"),
		});
	});
});
