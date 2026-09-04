import { describe, expect, test } from "bun:test";
import { seedGraph } from "./graph-store";

describe("seedGraph", () => {
	test("an unknown relation leaves no key, so the accessor reports unknown", () => {
		const graph = seedGraph([{ id: "1", parent: "unknown", blockers: "unknown", open: "unknown" }]);
		expect(graph.parent("1")).toBe("unknown");
		expect(graph.blockers("1")).toBe("unknown");
		expect(graph.isOpen("1")).toBe("unknown");
	});

	// The distinction the whole tri-state model rests on: a confirmed nothing is not an unread one, and
	// each of these values is falsy, which is how a `has`/`get` read differs from `get() ?? default`.
	test("a confirmed absence is distinct from an unknown one", () => {
		const graph = seedGraph([{ id: "1", parent: null, blockers: [], open: false }]);
		expect(graph.parent("1")).toBeNull();
		expect(graph.blockers("1")).toEqual([]);
		expect(graph.isOpen("1")).toBe(false);
	});

	test("an id never seeded is unknown in every relation", () => {
		const graph = seedGraph([{ id: "1", parent: null, blockers: ["2"], open: true }]);
		expect(graph.blockers("1")).toEqual(["2"]);
		expect(graph.parent("2")).toBe("unknown");
		expect(graph.blockers("2")).toBe("unknown");
		expect(graph.isOpen("2")).toBe("unknown");
	});

	test("reads back what was seeded", () => {
		const graph = seedGraph([
			{ id: "1", parent: null, blockers: [], open: true },
			{ id: "2", parent: "1", blockers: ["1", "3"], open: false },
		]);
		expect(graph.parent("2")).toBe("1");
		expect(graph.blockers("2")).toEqual(["1", "3"]);
		expect(graph.isOpen("2")).toBe(false);
		expect(graph.isOpen("1")).toBe(true);
	});

	test("a seeded blocker list is copied, so a later mutation cannot reach the graph", () => {
		const blockers = ["1"];
		const graph = seedGraph([{ id: "2", parent: null, blockers, open: true }]);
		blockers.push("99");
		expect(graph.blockers("2")).toEqual(["1"]);
	});

	// Copying in is only half of it: handing back the stored array let a consumer empty it, turning a
	// confirmed list of blockers into a confirmed absence of them, which re-derives as `unblocked`.
	test("a read blocker list is copied too, so a consumer cannot empty the graph", () => {
		const graph = seedGraph([{ id: "2", parent: null, blockers: ["1"], open: true }]);
		const read = graph.blockers("2") as string[];
		read.length = 0;
		read.push("99");
		expect(graph.blockers("2")).toEqual(["1"]);
	});
});
