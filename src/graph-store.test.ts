import { describe, expect, test } from "bun:test";
import { buildGraph, emptyGraphStore } from "./graph-store";

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
