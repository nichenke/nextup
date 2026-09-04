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

	test("reports a numeric priority too large to hold exactly, rather than ranking on it", () => {
		expect(readPriority(["P9007199254740993"])).toEqual({ rank: null, unread: ["p9007199254740993"] });
		expect(readPriority([`P${"9".repeat(400)}`]).rank).toBeNull();
	});

	test("ranks the largest value it can hold exactly, and refuses the one above it", () => {
		expect(readPriority(["P9007199254740991"]).rank).toBe(Number.MAX_SAFE_INTEGER);
		expect(readPriority(["P9007199254740992"]).rank).toBeNull();
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
