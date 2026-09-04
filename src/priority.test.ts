import { describe, expect, test } from "bun:test";
import { readPriority } from "./priority";

describe("readPriority", () => {
	test("reads the P<n> spelling, whatever its casing", () => {
		expect(readPriority(["P0"])).toEqual({ rank: 0, unread: [] });
		expect(readPriority(["p2"])).toEqual({ rank: 2, unread: [] });
	});

	test("reads the priority:<n> spelling", () => {
		expect(readPriority(["priority:1"])).toEqual({ rank: 1, unread: [] });
		expect(readPriority(["Priority: 3"])).toEqual({ rank: 3, unread: [] });
	});

	test("reports no signal where no label carries one", () => {
		expect(readPriority([])).toEqual({ rank: null, unread: [] });
		expect(readPriority(["bug", "perf", "P"])).toEqual({ rank: null, unread: [] });
	});

	test("takes the most urgent of several", () => {
		expect(readPriority(["P3", "priority:1"])).toEqual({ rank: 1, unread: [] });
	});

	test("reads no rank from a named priority, and reports it as unread", () => {
		expect(readPriority(["priority:high"])).toEqual({ rank: null, unread: ["priority:high"] });
	});

	test("still ranks on a numeric label alongside an unread named one", () => {
		expect(readPriority(["priority:high", "P1"])).toEqual({ rank: 1, unread: ["priority:high"] });
	});

	// `Number` is lossy past 2^53, so ranking on it read two distinct priorities as one: the pair below
	// converts to the same value, and a few hundred digits converts to Infinity. Both then tie on the
	// rung that claims to compare numbers, and the decision falls through.
	test("reports a numeric priority too large to hold exactly, rather than ranking on it", () => {
		expect(readPriority(["P9007199254740993"])).toEqual({ rank: null, unread: ["p9007199254740993"] });
		expect(readPriority([`P${"9".repeat(400)}`]).rank).toBeNull();
	});

	test("still ranks either side of the boundary", () => {
		expect(readPriority(["P9007199254740991"]).rank).toBe(9007199254740991);
		expect(readPriority(["P9007199254740992"]).rank).toBe(9007199254740992);
	});

	test("reads a leading-zero spelling as the number it writes", () => {
		expect(readPriority(["P01"])).toEqual({ rank: 1, unread: [] });
	});

	test("reports each unread label once, in a stable order", () => {
		expect(readPriority(["priority:urgent", "priority:high", "priority:URGENT"]).unread).toEqual([
			"priority:high",
			"priority:urgent",
		]);
	});
});
