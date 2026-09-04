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

	// A named value has no order this tool can supply, and guessing one silently reorders the backlog.
	// Reporting it is what lets a bad pick be traced to a label the ladder never read.
	test("reads no rank from a named priority, and reports it as unread", () => {
		expect(readPriority(["priority:high"])).toEqual({ rank: null, unread: ["priority:high"] });
	});

	test("still ranks on a numeric label alongside an unread named one", () => {
		expect(readPriority(["priority:high", "P1"])).toEqual({ rank: 1, unread: ["priority:high"] });
	});

	test("reports each unread label once, in a stable order", () => {
		expect(readPriority(["priority:urgent", "priority:high", "priority:URGENT"]).unread).toEqual([
			"priority:high",
			"priority:urgent",
		]);
	});
});
