import { type BlockedState, type DependencyGraph, type IssueId, deriveEffectiveBlockedness } from "./effective-blockedness";
import type { LabelFilter, LabelFilterSpec } from "./label-filter";
import { type PriorityReading, readPriority } from "./priority";
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
	/** This ticket's own priority-shaped labels the ladder could not order; see `readPriority`. */
	readonly unreadPriority: readonly string[];
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
 * A reason the answer is worth less than a confident one. The two are kept apart rather than folded
 * into one boolean because they call for different actions: a truncated fetch wants a narrower query,
 * and unconfirmed blocking wants a look at the tracker.
 */
export type Degrade = { readonly kind: "truncated" } | { readonly kind: "unconfirmed-blocking" };

/**
 * Where every ticket went. `closed + claimed + filtered + candidates === tickets` and
 * `confirmed + unconfirmed + blocked === candidates`, both by construction — see `tally`.
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
	/**
	 * Every unread priority label across the candidates that reached the ladder. A ticket that was
	 * closed, claimed, filtered out or confirmed blocked is never read for one — it could not have won
	 * whatever its priority, and `counts` already says why it did not.
	 */
	readonly unreadPrioritySignals: readonly string[];
	readonly filter: LabelFilterSpec;
}

export function select(input: SelectionInput): Selection {
	const ids = identify(input.tickets);
	const unblocks = countUnblocks(input.tickets, ids, input.graph);
	const placements = input.tickets.map((ticket) => place(ticket, ids.get(ticket)!, unblocks, input));

	const confirmed: Candidate[] = [];
	const unconfirmed: Candidate[] = [];
	for (const placement of placements) {
		if (placement.kind === "confirmed") confirmed.push(placement.candidate);
		if (placement.kind === "unconfirmed") unconfirmed.push(placement.candidate);
	}

	// Partition before the ladder, per ADR-0003.
	const consulted = confirmed.length > 0 ? "confirmed" : unconfirmed.length > 0 ? "unknown" : null;
	const ranked = [...(consulted === "unknown" ? unconfirmed : confirmed)].sort(byLadder);

	return {
		pick: ranked[0] ?? null,
		decision: decisionOf(ranked),
		consulted,
		ranked,
		counts: tally(placements),
		degraded: degradesOf(input.truncated, consulted === "unknown"),
		unreadPrioritySignals: unreadSignals([...confirmed, ...unconfirmed]),
		filter: input.filter.spec,
	};
}

/**
 * Where one ticket went. Every ticket produces exactly one of these and `tally` counts each kind
 * exactly once, which is what makes `SelectionCounts`'s totals add up by construction rather than by
 * every branch of a loop remembering to stop.
 */
type Placement =
	| { readonly kind: "closed" }
	| { readonly kind: "claimed" }
	| { readonly kind: "filtered" }
	| { readonly kind: "blocked" }
	| { readonly kind: "confirmed"; readonly candidate: Candidate }
	| { readonly kind: "unconfirmed"; readonly candidate: Candidate };

function place(
	ticket: Ticket,
	id: IssueId,
	unblocks: Map<IssueId, number>,
	input: SelectionInput,
): Placement {
	// Tested in this order, so a ticket that is both closed and claimed is placed once. Counting it
	// under both would make the totals say nothing.
	if (ticket.state === "closed") return { kind: "closed" };
	// Strictly unassigned: a claim recording no claimant is still a claim, and reading it as unclaimed
	// hands out a ticket somebody else is already working.
	if (ticket.claim !== null) return { kind: "claimed" };
	if (!input.filter.admits(ticket.labels)) return { kind: "filtered" };

	const state = deriveEffectiveBlockedness(id, input.graph);
	if (state === "blocked") return { kind: "blocked" };

	const candidate = candidateOf(ticket, state, readPriority(ticket.labels), unblocks.get(id) ?? 0);
	return state === "unblocked" ? { kind: "confirmed", candidate } : { kind: "unconfirmed", candidate };
}

/**
 * A `Record` keyed on the placement kinds rather than a switch: a kind added to `Placement` without a
 * bucket here fails to compile, so the totals cannot quietly stop accounting for every ticket.
 */
function tally(placements: readonly Placement[]): SelectionCounts {
	const counts: Record<Placement["kind"], number> = {
		closed: 0,
		claimed: 0,
		filtered: 0,
		blocked: 0,
		confirmed: 0,
		unconfirmed: 0,
	};
	for (const placement of placements) counts[placement.kind]++;
	return {
		tickets: placements.length,
		closed: counts.closed,
		claimed: counts.claimed,
		filtered: counts.filtered,
		candidates: counts.blocked + counts.confirmed + counts.unconfirmed,
		confirmed: counts.confirmed,
		unconfirmed: counts.unconfirmed,
		blocked: counts.blocked,
	};
}

/**
 * Each ticket's graph id, refusing a set in which two tickets share one. `seedGraph` refuses the same
 * collision, but the graph arrives already built here and need not have come from `seedGraph` at all —
 * and two tickets on one node read each other's blocking state.
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

/** How many open tickets each ticket unblocks — the second rung. ADR-0011 says what that counts. */
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

function candidateOf(
	ticket: Ticket,
	blocked: Exclude<BlockedState, "blocked">,
	priority: PriorityReading,
	unblocks: number,
): Candidate {
	return {
		ref: ticket.ref,
		title: ticket.title,
		url: ticket.url,
		labels: ticket.labels,
		blocked,
		priority: priority.rank,
		unreadPriority: priority.unread,
		unblocks,
	};
}

function unreadSignals(candidates: readonly Candidate[]): string[] {
	return [...new Set(candidates.flatMap((candidate) => candidate.unreadPriority))].sort();
}

/** The ladder, in order, each rung skipped when neither candidate carries its signal. */
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
