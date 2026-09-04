import { describe, expect, test } from "bun:test";
import { buildGraph, emptyGraphStore, seedGraph } from "./graph-store";

describe("buildGraph", () => {
	test("a missing key reads as unknown rather than a confident null, empty list, or false", () => {
		const graph = buildGraph(emptyGraphStore());
		expect(graph.parent("1")).toBe("unknown");
		expect(graph.blockers("1")).toBe("unknown");
		expect(graph.isOpen("1")).toBe("unknown");
	});

	test("a present key reads as its confirmed value, including the falsy ones", () => {
		const store = emptyGraphStore();
		store.parents.set("1", null);
		store.blockers.set("1", []);
		store.openness.set("1", false);
		const graph = buildGraph(store);
		expect(graph.parent("1")).toBeNull();
		expect(graph.blockers("1")).toEqual([]);
		expect(graph.isOpen("1")).toBe(false);
	});

	test("reads what was stored", () => {
		const store = emptyGraphStore();
		store.parents.set("2", "1");
		store.blockers.set("2", ["1", "3"]);
		store.openness.set("2", true);
		const graph = buildGraph(store);
		expect(graph.parent("2")).toBe("1");
		expect(graph.blockers("2")).toEqual(["1", "3"]);
		expect(graph.isOpen("2")).toBe(true);
	});
});

// This is the seam every adapter seeds through, so that the mapping from "unknown" to an absent key
// exists once rather than being rewritten — slightly differently — per tracker.
describe("seedGraph", () => {
	test("an unknown relation leaves no key, so the accessor reports unknown", () => {
		const graph = seedGraph([{ id: "1", parent: "unknown", blockers: "unknown", open: "unknown" }]);
		expect(graph.parent("1")).toBe("unknown");
		expect(graph.blockers("1")).toBe("unknown");
		expect(graph.isOpen("1")).toBe("unknown");
	});

	test("a confirmed absence is distinct from an unknown one", () => {
		const graph = seedGraph([{ id: "1", parent: null, blockers: [], open: false }]);
		expect(graph.parent("1")).toBeNull();
		expect(graph.blockers("1")).toEqual([]);
		expect(graph.isOpen("1")).toBe(false);
	});

	test("a ticket named only as another's blocker has no relations of its own", () => {
		const graph = seedGraph([{ id: "1", parent: null, blockers: ["2"], open: true }]);
		expect(graph.blockers("1")).toEqual(["2"]);
		expect(graph.isOpen("2")).toBe("unknown");
	});

	test("reads what was seeded", () => {
		const store = emptyGraphStore();
		store.parents.set("2", "1");
		store.blockers.set("2", ["1", "3"]);
		store.openness.set("2", true);
		const graph = buildGraph(store);
		expect(graph.parent("2")).toBe("1");
		expect(graph.blockers("2")).toEqual(["1", "3"]);
		expect(graph.isOpen("2")).toBe(true);
	});
});
