// Ported from `ai-bob-brain`'s `plugin/lib/dependency-graph.ts`; ADR-0007 records what stayed behind.

import type { DependencyGraph, IssueId } from "./effective-blockedness";

/**
 * Backing store for one adapter's reads. A MISSING key means the relation was never confirmed for
 * that id, which every accessor reports as `"unknown"`; a present key carries a confirmed value,
 * including a falsy one.
 */
interface GraphStore {
	/** `null` is a confirmed absence of a parent, distinct from an unread one. */
	parents: Map<IssueId, IssueId | null>;
	blockers: Map<IssueId, IssueId[]>;
	openness: Map<IssueId, boolean>;
}

/** Wrap a populated `GraphStore` as the `DependencyGraph` port. */
function buildGraph(store: GraphStore): DependencyGraph {
	return {
		parent(id: IssueId): IssueId | null | "unknown" {
			return store.parents.has(id) ? store.parents.get(id)! : "unknown";
		},
		blockers(id: IssueId): IssueId[] | "unknown" {
			// Copied on the way out as well as in. Handing back the stored array let a consumer empty it
			// and turn a confirmed list of blockers into a confirmed absence of them, which re-derives as
			// `unblocked` — the seam exists to make that unreachable, and a shared reference reopened it.
			return store.blockers.has(id) ? [...store.blockers.get(id)!] : "unknown";
		},
		isOpen(id: IssueId): boolean | "unknown" {
			return store.openness.has(id) ? store.openness.get(id)! : "unknown";
		},
	};
}

function emptyGraphStore(): GraphStore {
	return { parents: new Map(), blockers: new Map(), openness: new Map() };
}

/**
 * One ticket's relations as its adapter read them. Every field is tri-state, and `"unknown"` is
 * spelled rather than implied — an adapter says what it could not confirm instead of expressing it by
 * omission, which is the mistake this type exists to make unavailable.
 */
export interface GraphSeed {
	readonly id: IssueId;
	/** `null` is a confirmed absence of a parent; `"unknown"` is a containment read that failed. */
	readonly parent: IssueId | null | "unknown";
	/** `[]` is a confirmed absence of blockers; `"unknown"` is an edge read that failed. */
	readonly blockers: readonly IssueId[] | "unknown";
	/** `"unknown"` is a read that failed, and only that. A closed ticket is closed — ADR-0021. */
	readonly open: boolean | "unknown";
}

/**
 * Build the graph every adapter hands to the traversal. This exists so that the mapping from
 * "unknown" to an absent key lives once: writing the loop per adapter, each is one keystroke from
 * `blockers.set(id, [])` for blockers it never read, which type-checks and reports a confident
 * `unblocked` where the honest answer is that nothing is known. That is the collapse `CONTEXT.md`
 * forbids, and an adapter shipped it once already.
 */
export function seedGraph(seeds: Iterable<GraphSeed>): DependencyGraph {
	const store = emptyGraphStore();
	const seen = new Set<IssueId>();
	for (const seed of seeds) {
		// Two seeds for one id means two tickets have collapsed onto one node, and the second would
		// overwrite the first's openness — a real open blocker read as closed, and its dependent reported
		// unblocked. Silently taking the last write is how an identity mistake becomes that collapse, so
		// this refuses instead. It is a caller invariant rather than malformed input: an adapter enumerates
		// distinct tickets, so reaching this means the ids do not distinguish what the refs distinguish.
		if (seen.has(seed.id)) {
			throw new Error(`two tickets share the graph id ${seed.id}; ticket identity is not distinguishing them`);
		}
		seen.add(seed.id);
		if (seed.parent !== "unknown") store.parents.set(seed.id, seed.parent);
		if (seed.blockers !== "unknown") store.blockers.set(seed.id, [...seed.blockers]);
		if (seed.open !== "unknown") store.openness.set(seed.id, seed.open);
	}
	return buildGraph(store);
}
