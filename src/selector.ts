import { type BlockedState, type DependencyGraph, type IssueId, deriveEffectiveBlockedness } from "./effective-blockedness";
import type { LabelFilter, LabelFilterSpec } from "./label-filter";
import { readPriority } from "./priority";
import { type Ticket, ticketId } from "./ticket";
import { type TicketRef, compareTicketRefs } from "./ticket-ref";

export class SelectionError extends Error {}

/**
 * Everything the decision is made from. Pure in, pure out: `select` reads nothing else and writes
 * nothing, so the same input always yields the same selection and a fixture can assert it exactly.
 *
 * `graph` spans *every* ticket, including the ones `filter` drops. That asymmetry is the point —
 * excluding the wayfinder track from candidates must not make a backlog ticket waiting on an open
 * decision look ready to start.
 */
export interface SelectionInput {
	readonly tickets: readonly Ticket[];
	readonly graph: DependencyGraph;
	readonly filter: LabelFilter;
	/**
	 * Whether the fetch that produced `tickets` stopped short of the whole ticket set. Required rather
	 * than defaulted, so an adapter has to state it: defaulting to `false` is how a partial page of a
	 * large backlog gets presented as the complete one.
	 */
	readonly truncated: boolean;
}

/** One rung of the ladder, fixed in code and in this order per ADR-0003. */
export type Rung = "priority" | "unblocks" | "reference";

export interface Candidate {
	readonly ref: TicketRef;
	readonly title: string;
	readonly url: string | null;
	readonly labels: readonly string[];
	/** Never `"blocked"`: a confirmed-blocked ticket is not recommendable and is not ranked. */
	readonly blocked: "unblocked" | "unknown";
	/** Lower is more urgent; `null` where no label carried a priority the ladder reads. */
	readonly priority: number | null;
	/** How many open tickets in the set are waiting on this one. */
	readonly unblocks: number;
}

/**
 * Why the pick won. `over` names the runner-up, because a rung explains a decision only against the
 * candidate it beat — "priority decided it" says nothing on its own.
 */
export type Decision =
	| { readonly kind: "only-candidate" }
	| { readonly kind: "rung"; readonly rung: Rung; readonly over: TicketRef };

/**
 * A reason the answer is worth less than a confident one. Both readings survive into the output and
 * into the human rendering's sentinel line, rather than being folded into a single boolean, because
 * they call for different actions: a truncated fetch wants a narrower query, and unconfirmed blocking
 * wants a look at the tracker.
 */
export type Degrade = { readonly kind: "truncated" } | { readonly kind: "unconfirmed-blocking" };

/**
 * Where every ticket went. The two invariants a reader can rely on:
 * `closed + claimed + filtered + candidates === tickets`, and
 * `confirmed + unconfirmed + blocked === candidates`.
 */
export interface SelectionCounts {
	readonly tickets: number;
	readonly closed: number;
	readonly claimed: number;
	readonly filtered: number;
	readonly candidates: number;
	readonly confirmed: number;
	readonly unconfirmed: number;
	readonly blocked: number;
}

export interface Selection {
	readonly pick: Candidate | null;
	readonly decision: Decision | null;
	/** Which partition the ranking was taken from; `null` when nothing was recommendable. */
	readonly consulted: "confirmed" | "unknown" | null;
	/** The consulted partition, ranked. The other partition is reported only as a count. */
	readonly ranked: readonly Candidate[];
	readonly counts: SelectionCounts;
	readonly degraded: readonly Degrade[];
	/** Priority-shaped labels the ladder could not order; see `readPriority`. */
	readonly unreadPrioritySignals: readonly string[];
	readonly filter: LabelFilterSpec;
}

export function select(input: SelectionInput): Selection {
	const ids = identify(input.tickets);
	const unblocks = countUnblocks(input.tickets, ids, input.graph);

	let closed = 0;
	let claimed = 0;
	let filtered = 0;
	let blocked = 0;
	const confirmed: Candidate[] = [];
	const unconfirmed: Candidate[] = [];
	const unread = new Set<string>();

	for (const ticket of input.tickets) {
		// Counted in this order so that every ticket lands in exactly one bucket. A ticket can be both
		// closed and claimed, and counting it twice would make the totals say nothing.
		if (ticket.state === "closed") {
			closed++;
			continue;
		}
		// Strictly unassigned: a claim recording no claimant is still a claim, and reading it as
		// unclaimed hands out a ticket somebody else is already working.
		if (ticket.claim !== null) {
			claimed++;
			continue;
		}
		if (!input.filter.admits(ticket.labels)) {
			filtered++;
			continue;
		}

		const state = deriveEffectiveBlockedness(ids.get(ticket)!, input.graph);
		if (state === "blocked") {
			blocked++;
			continue;
		}

		const priority = readPriority(ticket.labels);
		for (const label of priority.unread) unread.add(label);
		const candidate = candidateOf(ticket, state, priority.rank, unblocks.get(ids.get(ticket)!) ?? 0);
		(state === "unblocked" ? confirmed : unconfirmed).push(candidate);
	}

	// The partition is applied before the ladder, not tiebroken inside it: an unknown-blocking P0 would
	// otherwise beat a confirmed-unblocked P1 on the first rung, which is the opposite of "surfaces only
	// when nothing confirmed-unblocked is left". ADR-0003 records the earlier formulation and why it failed.
	const consulted = confirmed.length > 0 ? "confirmed" : unconfirmed.length > 0 ? "unknown" : null;
	const ranked = [...(consulted === "unknown" ? unconfirmed : confirmed)].sort(byLadder);

	return {
		pick: ranked[0] ?? null,
		decision: decisionOf(ranked),
		consulted,
		ranked,
		counts: {
			tickets: input.tickets.length,
			closed,
			claimed,
			filtered,
			candidates: confirmed.length + unconfirmed.length + blocked,
			confirmed: confirmed.length,
			unconfirmed: unconfirmed.length,
			blocked,
		},
		degraded: degradesOf(input.truncated, consulted === "unknown"),
		unreadPrioritySignals: [...unread].sort(),
		filter: input.filter.spec,
	};
}

/**
 * Each ticket's graph id, refusing a set in which two tickets share one. `seedGraph` refuses the same
 * collision, but the graph arrives already built here and may not have come from `seedGraph` at all —
 * and two tickets on one node read each other's blocking state, so the second is reported against the
 * first's blockers.
 */
function identify(tickets: readonly Ticket[]): Map<Ticket, IssueId> {
	const ids = new Map<Ticket, IssueId>();
	const seen = new Set<IssueId>();
	for (const ticket of tickets) {
		const id = ticketId(ticket.ref);
		if (seen.has(id)) {
			throw new SelectionError(`two tickets share the graph id ${id}; ticket identity is not distinguishing them`);
		}
		seen.add(id);
		ids.set(ticket, id);
	}
	return ids;
}

/**
 * How many open tickets each ticket unblocks — the second rung. Closed dependents are not counted:
 * nothing is waiting on them, so counting them ranks a ticket highly for work already finished.
 *
 * Read from the graph rather than from `Ticket.blockers`, so the rung and the blocking derivation
 * cannot come to disagree about which edges exist. A ticket whose own blockers are `"unknown"`
 * contributes no edges, which makes every count a lower bound rather than an inflated one.
 */
function countUnblocks(
	tickets: readonly Ticket[],
	ids: Map<Ticket, IssueId>,
	graph: DependencyGraph,
): Map<IssueId, number> {
	const counts = new Map<IssueId, number>();
	for (const ticket of tickets) {
		if (ticket.state !== "open") continue;
		const dependent = ids.get(ticket)!;
		const blockers = graph.blockers(dependent);
		if (blockers === "unknown") continue;
		for (const blocker of new Set(blockers)) {
			if (blocker === dependent) continue;
			counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
		}
	}
	return counts;
}

function candidateOf(ticket: Ticket, blocked: BlockedState, priority: number | null, unblocks: number): Candidate {
	return {
		ref: ticket.ref,
		title: ticket.title,
		url: ticket.url,
		labels: ticket.labels,
		blocked: blocked === "unblocked" ? "unblocked" : "unknown",
		priority,
		unblocks,
	};
}

/**
 * The ladder itself, in order, each rung skipped when neither candidate carries its signal. The last
 * rung is total over distinct references, so this never returns 0 for two different candidates and the
 * order never falls through to the order the tickets arrived in.
 */
function byLadder(a: Candidate, b: Candidate): number {
	return comparePriority(a.priority, b.priority) || b.unblocks - a.unblocks || compareTicketRefs(a.ref, b.ref);
}

/** Lower is more urgent, and a candidate carrying no priority sorts after every one that does. */
function comparePriority(a: number | null, b: number | null): number {
	if (a === null) return b === null ? 0 : 1;
	if (b === null) return -1;
	return a - b;
}

function decisionOf(ranked: readonly Candidate[]): Decision | null {
	const pick = ranked[0];
	if (pick === undefined) return null;
	const runnerUp = ranked[1];
	if (runnerUp === undefined) return { kind: "only-candidate" };
	return { kind: "rung", rung: decidingRung(pick, runnerUp), over: runnerUp.ref };
}

/** The first rung on which the pick actually beat the runner-up. */
function decidingRung(pick: Candidate, runnerUp: Candidate): Rung {
	if (comparePriority(pick.priority, runnerUp.priority) !== 0) return "priority";
	if (pick.unblocks !== runnerUp.unblocks) return "unblocks";
	return "reference";
}

function degradesOf(truncated: boolean, unconfirmed: boolean): Degrade[] {
	const degrades: Degrade[] = [];
	if (truncated) degrades.push({ kind: "truncated" });
	if (unconfirmed) degrades.push({ kind: "unconfirmed-blocking" });
	return degrades;
}
