import { describe, expect, test } from "bun:test";
import { findBlockingCycles } from "./deadlock";
import type { DependencyGraph, IssueId } from "./effective-blockedness";
import { type GraphSeed, seedGraph } from "./graph-store";

/**
 * One node as a scenario writes it: its blockers and whether it is open, both tri-state through
 * `seedGraph`. `open` defaults to true, so a test says only what it is about.
 */
type Node = { readonly blockers: readonly IssueId[] | "unknown"; readonly open?: boolean | "unknown" };

function graphOf(nodes: Record<IssueId, Node>): { graph: DependencyGraph; ids: IssueId[] } {
	const seeds: GraphSeed[] = Object.entries(nodes).map(([id, node]) => ({
		id,
		parent: null,
		blockers: node.blockers,
		open: node.open ?? true,
	}));
	return { graph: seedGraph(seeds), ids: Object.keys(nodes) };
}

function cycles(nodes: Record<IssueId, Node>): readonly (readonly IssueId[])[] {
	const { graph, ids } = graphOf(nodes);
	return findBlockingCycles(ids, graph);
}

/** Records which ids the edges were asked for, which is what the walk's one held read is observable as. */
function countingGraph(nodes: Record<IssueId, Node>): { graph: DependencyGraph; edgeReads: IssueId[]; ids: IssueId[] } {
	const { graph, ids } = graphOf(nodes);
	const edgeReads: IssueId[] = [];
	return {
		ids,
		edgeReads,
		graph: {
			...graph,
			blockers(id) {
				edgeReads.push(id);
				return graph.blockers(id);
			},
		},
	};
}

describe("findBlockingCycles", () => {
	test("reports nothing over a chain, however long", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: ["c"] }, c: { blockers: [] } })).toEqual([]);
	});

	test("names a two-member cycle, each ticket blocked by the next", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: ["a"] } })).toEqual([["a", "b"]]);
	});

	test("names a three-member cycle in an order that closes on the first", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: ["c"] }, c: { blockers: ["a"] } })).toEqual([
			["a", "b", "c"],
		]);
	});

	test("reports a self-blocking ticket as the one-member case", () => {
		expect(cycles({ a: { blockers: ["a"] } })).toEqual([["a"]]);
	});

	test("does not report a cycle one of whose members is closed", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: ["c"] }, c: { blockers: ["a"], open: false } })).toEqual(
			[],
		);
	});

	test("does not report a diamond", () => {
		expect(
			cycles({ a: { blockers: ["b", "c"] }, b: { blockers: ["d"] }, c: { blockers: ["d"] }, d: { blockers: [] } }),
		).toEqual([]);
	});

	test("does not report a cycle resting on an edge the tracker could not report", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: "unknown" } })).toEqual([]);
	});

	test("does not report a cycle through a ticket whose openness could not be confirmed", () => {
		expect(cycles({ a: { blockers: ["b"] }, b: { blockers: ["a"], open: "unknown" } })).toEqual([]);
	});

	// The walk begins at each ticket in turn, so these are the cases where the only closed ticket in a
	// cycle is the one it started from.
	test("does not report a cycle whose members are all closed", () => {
		expect(cycles({ a: { blockers: ["b"], open: false }, b: { blockers: ["a"], open: false } })).toEqual([]);
	});

	test("does not report a closed ticket that blocks itself", () => {
		expect(cycles({ a: { blockers: ["a"], open: false } })).toEqual([]);
	});

	test("reports two disjoint cycles, each once", () => {
		expect(
			cycles({
				a: { blockers: ["b"] },
				b: { blockers: ["a"] },
				c: { blockers: ["d"] },
				d: { blockers: ["c"] },
			}),
		).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	// The tickets outside the cycle are blocked by it and the counts say so, but naming them in the cycle
	// would send a reader looking for an edge back that no ticket carries.
	test("names only the tickets on the cycle, not the ones it blocks", () => {
		expect(
			cycles({ a: { blockers: ["b"] }, b: { blockers: ["a"] }, c: { blockers: ["a"] } }),
		).toEqual([["a", "b"]]);
	});

	test("starts a group's first cycle at its lowest-ordered member, whichever ticket the walk began from", () => {
		expect(cycles({ c: { blockers: ["a"] }, a: { blockers: ["b"] }, b: { blockers: ["c"] } })).toEqual([
			["a", "b", "c"],
		]);
	});

	// A three-member cycle reported first while a two-member one exists in the same group — so "shortest"
	// holds per starting ticket and not across the group, which is what ADR-0030 says and what a reader of
	// the report has to know before treating the first line as the smallest thing to fix.
	test("reports the shortest cycle through each start, not the shortest in the group", () => {
		expect(
			cycles({
				a: { blockers: ["b"] },
				b: { blockers: ["c", "d"] },
				c: { blockers: ["a"] },
				d: { blockers: ["b"] },
			}),
		).toEqual([
			["a", "b", "c"],
			["d", "b"],
		]);
	});

	test("reports interlocking cycles without repeating a member set", () => {
		const reported = cycles({ a: { blockers: ["b", "c"] }, b: { blockers: ["a"] }, c: { blockers: ["a"] } });
		expect(reported).toEqual([["a", "b"], ["c", "a"]]);
	});

	test("does not follow an edge out of the given ticket set", () => {
		const { graph } = graphOf({ a: { blockers: ["b"] }, b: { blockers: ["a"] } });
		expect(findBlockingCycles(["a"], graph)).toEqual([]);
	});

	test("reads a repeated edge as the one edge it is", () => {
		expect(cycles({ a: { blockers: ["b", "b"] }, b: { blockers: ["a"] } })).toEqual([["a", "b"]]);
	});

	// Two cycles of one length, so only the order the edges are walked in decides which is reported. The
	// order a tracker listed them in is not that: the same repository would answer differently between two
	// runs, and the fixtures pinning this output would be asserting whichever it answered first.
	test("breaks a tie between equally short cycles by graph id, not by the order the edges arrived", () => {
		expect(cycles({ a: { blockers: ["c", "b"] }, b: { blockers: ["a"] }, c: { blockers: ["a"] } })).toEqual([
			["a", "b"],
			["c", "a"],
		]);
	});

	test("reports nothing over an empty ticket set", () => {
		expect(cycles({})).toEqual([]);
	});

	// A walk starts at every ticket and they cross the same ones, so without the held read this set asks for
	// the shared ticket's edges once per walk that reaches it — quadratic in the ticket set, which at a
	// thousand tickets was the difference between 469ms and 72ms.
	test("asks for a ticket's edges once however many walks reach it", () => {
		const { graph, ids, edgeReads } = countingGraph({
			a: { blockers: ["b", "c"] },
			b: { blockers: ["d"] },
			c: { blockers: ["d"] },
			d: { blockers: [] },
		});
		expect(findBlockingCycles(ids, graph)).toEqual([]);
		expect(edgeReads).toEqual([...new Set(edgeReads)]);
	});

	// The held read is per call, so a graph whose answer changed between two calls is answered from what it
	// says now — the alternative, a cache outliving the call, would report yesterday's cycles.
	test("reads the graph again on a second call", () => {
		const { graph, ids, edgeReads } = countingGraph({ a: { blockers: ["b"] }, b: { blockers: ["a"] } });
		findBlockingCycles(ids, graph);
		const afterFirst = edgeReads.length;
		findBlockingCycles(ids, graph);
		expect(edgeReads.length).toBeGreaterThan(afterFirst);
	});
});
