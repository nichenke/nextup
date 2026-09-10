import type { DependencyGraph, IssueId } from "./effective-blockedness";
import type { NonEmpty } from "./non-empty";

/** Non-empty because a cycle naming no ticket renders as a claim with nothing in it to act on. */
export type BlockingCycle = NonEmpty<IssueId>;

/**
 * Blocking cycles over the graph port, so every adapter gets the diagnostic from one implementation
 * rather than each refusing cycles its own way. ADR-0030 has why this is the selector's job and not an
 * adapter's, and what a reported cycle claims.
 *
 * What it will not report — an unconfirmed ticket, an unread edge, a loop holding a closed ticket, a loop
 * leaving `nodes` — and why each of those follows from what the line claims, is ADR-0030's.
 *
 * Openness is asked in one place, of a ticket the walk is about to enter as somebody's blocker. That covers
 * the ticket a walk *started* from as well, because a cycle through it closes on an edge into it, so a
 * confirmed-open check on the start node would decide nothing a second time.
 *
 * @param nodes the ids of the tickets the read returned
 * @returns a shortest cycle through each ticket no earlier one already named, in ascending graph-id order —
 *   which is not reference order, and `findDeadlocks` in `selector.ts` is where the report is turned and
 *   ordered for a reader. Each cycle is ordered so that every ticket is blocked by the next and the last is
 *   blocked by the first, and a self-blocking ticket is the one-member case. So interlocking loops can yield more than
 *   one report for what a reader would call one deadlock, and none of them need be the group's shortest —
 *   naming the group without its edges instead would leave a reader no path to follow.
 */
export function findBlockingCycles(nodes: Iterable<IssueId>, graph: DependencyGraph): readonly BlockingCycle[] {
	const within = new Set(nodes);
	const blockersOf = memoizedBlockers(within, graph);
	const looping = loopingNodes(within, blockersOf);

	const cycles: BlockingCycle[] = [];
	const reported = new Set<IssueId>();
	for (const start of [...within].sort()) {
		if (!looping.has(start) || reported.has(start)) continue;
		const cycle = shortestCycleThrough(start, blockersOf);
		if (cycle === null) continue;
		cycles.push(cycle);
		for (const member of cycle) reported.add(member);
	}
	return cycles;
}

/**
 * The tickets that lie on some cycle, which is a property of the strongly connected components: a component
 * of more than one ticket is mutually reachable and therefore looping, and a lone ticket loops only by
 * blocking itself.
 *
 * This is what keeps a healthy ticket set cheap: walking from every ticket instead means a set with no cycle
 * in it pays a traversal per ticket to find nothing. The answer is unchanged, because every cycle through a
 * ticket lies inside that ticket's own component, so a ticket in none of them had no cycle to report.
 * ADR-0030 has what that saved, over which shapes.
 *
 * Iterative rather than recursive (Tarjan, 1972): the depth is the ticket set's, and a tracker's own limit is
 * what bounds that rather than anything here.
 */
function loopingNodes(within: ReadonlySet<IssueId>, blockersOf: (node: IssueId) => readonly IssueId[]): Set<IssueId> {
	const looping = new Set<IssueId>();
	const index = new Map<IssueId, number>();
	const low = new Map<IssueId, number>();
	const open: IssueId[] = [];
	const isOpen = new Set<IssueId>();
	let counter = 0;

	const enter = (node: IssueId): { node: IssueId; edges: readonly IssueId[]; at: number } => {
		index.set(node, counter);
		low.set(node, counter);
		counter++;
		open.push(node);
		isOpen.add(node);
		return { node, edges: blockersOf(node), at: 0 };
	};

	for (const root of within) {
		if (index.has(root)) continue;
		const walk = [enter(root)];
		while (walk.length > 0) {
			const frame = walk[walk.length - 1]!;
			if (frame.at < frame.edges.length) {
				const blocker = frame.edges[frame.at++]!;
				if (!index.has(blocker)) walk.push(enter(blocker));
				else if (isOpen.has(blocker)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(blocker)!));
				continue;
			}

			walk.pop();
			const caller = walk[walk.length - 1];
			if (caller !== undefined) low.set(caller.node, Math.min(low.get(caller.node)!, low.get(frame.node)!));
			if (low.get(frame.node) !== index.get(frame.node)) continue;

			const component: IssueId[] = [];
			for (let member = open.pop()!; ; member = open.pop()!) {
				isOpen.delete(member);
				component.push(member);
				if (member === frame.node) break;
			}
			const alone = component.length === 1 ? component[0]! : null;
			if (alone === null) for (const member of component) looping.add(member);
			else if (blockersOf(alone).includes(alone)) looping.add(alone);
		}
	}
	return looping;
}

/**
 * The component pass and every walk ask the same tickets for their edges, and `graph.blockers` copies its list
 * on the way out, so the reads are held for the length of one call. ADR-0030 has what that is worth.
 *
 * Safe against the one implementation there is: `seedGraph` answers from a map it built and copies on the
 * way out, so asking twice cannot differ. The port promises no such thing — `DependencyGraph` says only that
 * a relation is a confirmed value or `"unknown"` — so a graph that fetched lazily would need to answer
 * stably for the length of a call, or this held read has to go.
 */
function memoizedBlockers(
	within: ReadonlySet<IssueId>,
	graph: DependencyGraph,
): (node: IssueId) => readonly IssueId[] {
	const known = new Map<IssueId, readonly IssueId[]>();
	return (node) => {
		const cached = known.get(node);
		if (cached !== undefined) return cached;
		const blockers = confirmedBlockers(node, within, graph);
		known.set(node, blockers);
		return blockers;
	};
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
	blockersOf: (node: IssueId) => readonly IssueId[],
): BlockingCycle | null {
	const from = new Map<IssueId, IssueId>();
	const queue: IssueId[] = [start];
	while (queue.length > 0) {
		const node = queue.shift()!;
		for (const blocker of blockersOf(node)) {
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
