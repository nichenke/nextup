// Ported from `ai-bob-brain`'s `plugin/lib/dependency-graph.ts`; ADR-0007 records what stayed behind.

import type { DependencyGraph, IssueId } from "./effective-blockedness";

/**
 * Backing store for one adapter's reads. A MISSING key means the relation was never confirmed for
 * that id, which every accessor reports as `"unknown"`; a present key carries a confirmed value,
 * including a falsy one.
 */
export interface GraphStore {
	/** `null` is a confirmed absence of a parent, distinct from an unread one. */
	parents: Map<IssueId, IssueId | null>;
	blockers: Map<IssueId, IssueId[]>;
	openness: Map<IssueId, boolean>;
}

/** Wrap a populated `GraphStore` as the `DependencyGraph` port. */
export function buildGraph(store: GraphStore): DependencyGraph {
	return {
		parent(id: IssueId): IssueId | null | "unknown" {
			return store.parents.has(id) ? store.parents.get(id)! : "unknown";
		},
		blockers(id: IssueId): IssueId[] | "unknown" {
			return store.blockers.has(id) ? store.blockers.get(id)! : "unknown";
		},
		isOpen(id: IssueId): boolean | "unknown" {
			return store.openness.has(id) ? store.openness.get(id)! : "unknown";
		},
	};
}

export function emptyGraphStore(): GraphStore {
	return { parents: new Map(), blockers: new Map(), openness: new Map() };
}
