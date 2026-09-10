import type { DependencyGraph, IssueId } from "./effective-blockedness";
import type { NonEmpty } from "./non-empty";

/** Non-empty because a cycle naming no ticket renders as a claim with nothing in it to act on. */
export type BlockingCycle = NonEmpty<IssueId>;

/**
 * Blocking cycles over the graph port, so every adapter gets the diagnostic from one implementation
 * rather than each refusing cycles its own way. ADR-0030 has why this is the selector's job and not an
 * adapter's, and what a reported cycle claims.
 *
 * A cycle is reported only where every ticket in it is *confirmed* open and every edge in it is one the
 * tracker reported. Both are the same rule: the report says these tickets can never unblock each other,
 * and an unread edge could be the one that is not there. A closed member prunes for the reason
 * `deriveEffectiveBlockedness` prunes at one — a closed blocker is a met dependency — so a cycle
 * containing one is not a deadlock, and its dependent really is unblocked.
 *
 * Openness is asked in one place, of a ticket the walk is about to enter as somebody's blocker. That covers
 * the ticket a walk *started* from as well, because a cycle through it closes on an edge into it, so a
 * confirmed-open check on the start node would decide nothing a second time.
 *
 * Edges are followed only within `nodes`. The graph spans blockers the read never returned as rows, and
 * their own edges are unread, so a cycle through one could not be confirmed anyway.
 *
 * @param nodes the ids of the tickets the read returned
 * @returns a shortest cycle through each ticket no earlier one already named, in ascending order of first
 *   member; each cycle is ordered so that every ticket is blocked by the next and the last is blocked by
 *   the first, and a self-blocking ticket is the one-member case. So interlocking loops can yield more than
 *   one report for what a reader would call one deadlock, and none of them need be the group's shortest —
 *   naming the group without its edges instead would leave a reader no path to follow.
 */
export function findBlockingCycles(nodes: Iterable<IssueId>, graph: DependencyGraph): readonly BlockingCycle[] {
	const within = new Set(nodes);
	const cycles: BlockingCycle[] = [];
	const reported = new Set<IssueId>();
	for (const start of [...within].sort()) {
		if (reported.has(start)) continue;
		const cycle = shortestCycleThrough(start, within, graph);
		if (cycle === null) continue;
		cycles.push(cycle);
		for (const member of cycle) reported.add(member);
	}
	return cycles;
}

/** Sorted, so which of two equally short cycles gets reported is the same on every run. */
function confirmedBlockers(node: IssueId, within: ReadonlySet<IssueId>, graph: DependencyGraph): IssueId[] {
	const blockers = graph.blockers(node);
	if (blockers === "unknown") return [];
	return blockers.filter((blocker) => within.has(blocker) && graph.isOpen(blocker) === true).sort();
}

/**
 * The shortest cycle through `start`, or `null` where none exists. Breadth-first, so the first edge back
 * to `start` closes a shortest one: the report names as few tickets as any loop through `start` can, rather
 * than whichever longer one a depth-first walk wandered into.
 *
 * Bounded by the graph: a node is enqueued once, and `start` is never re-enqueued because reaching it
 * returns.
 */
function shortestCycleThrough(
	start: IssueId,
	within: ReadonlySet<IssueId>,
	graph: DependencyGraph,
): BlockingCycle | null {
	const from = new Map<IssueId, IssueId>();
	const queue: IssueId[] = [start];
	while (queue.length > 0) {
		const node = queue.shift()!;
		for (const blocker of confirmedBlockers(node, within, graph)) {
			if (blocker === start) return walkBack(node, start, from);
			if (from.has(blocker)) continue;
			from.set(blocker, node);
			queue.push(blocker);
		}
	}
	return null;
}

/**
 * `start` first, then each ticket blocking the one before it, ending at `node`, which blocks `start`.
 * Built with `start` in hand rather than reversed into place, so the result is a non-empty cycle by
 * construction and the self-blocking case is the same expression with nothing between the two.
 */
function walkBack(node: IssueId, start: IssueId, from: ReadonlyMap<IssueId, IssueId>): BlockingCycle {
	const back: IssueId[] = [];
	for (let step = node; step !== start; step = from.get(step)!) back.push(step);
	return [start, ...back.reverse()];
}
