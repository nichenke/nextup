import { describe, expect, test } from "bun:test";
import { readPriority } from "./priority";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import { GITHUB_TEST_TREE, type TestTreeSpec, TestTreeError, validateTestTree } from "./test-tree";

const tree = GITHUB_TEST_TREE;

function issue(key: string) {
	const found = tree.issues.find((candidate) => candidate.key === key);
	if (found === undefined) throw new Error(`no issue keyed ${key}`);
	return found;
}

/** How many hops of open blockers separate `key` from an issue nothing open blocks. */
function openDepth(key: string, seen: readonly string[] = []): number {
	if (seen.includes(key)) return Number.POSITIVE_INFINITY;
	const open = issue(key).blockedBy.filter((blocker) => !issue(blocker).closed);
	if (open.length === 0) return 0;
	return 1 + Math.max(...open.map((blocker) => openDepth(blocker, [...seen, key])));
}

describe("validateTestTree", () => {
	test("accepts the GitHub test tree", () => {
		expect(() => validateTestTree(tree)).not.toThrow();
	});

	test("refuses a repeated key", () => {
		const spec: TestTreeSpec = { ...tree, issues: [issue("no-priority"), issue("no-priority")] };
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	test("refuses a blocker that names no issue", () => {
		const spec: TestTreeSpec = { ...tree, issues: [{ ...issue("no-priority"), blockedBy: ["absent"] }] };
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	test("refuses a label the spec does not declare", () => {
		const spec: TestTreeSpec = { ...tree, issues: [{ ...issue("no-priority"), labels: ["undeclared"] }] };
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});
});

// Each test below is one shape ticket 35 requires the tree to carry. They fail if the spec is edited in
// a way that drops a shape, which is the only thing stopping the tree from silently narrowing.
describe("the shapes the GitHub test tree carries", () => {
	test("a chain of open blockers at least two deep", () => {
		expect(openDepth("chain-tip")).toBeGreaterThanOrEqual(2);
	});

	test("a ticket blocked by a closed blocker and an open one at once", () => {
		const blockers = issue("mixed-blockers").blockedBy.map(issue);
		expect(blockers.filter((blocker) => blocker.closed)).toHaveLength(1);
		expect(blockers.filter((blocker) => !blocker.closed)).toHaveLength(1);
	});

	test("a ticket whose every blocker is closed, so the open count and the total disagree", () => {
		const blockers = issue("every-blocker-closed").blockedBy.map(issue);
		expect(blockers).not.toHaveLength(0);
		expect(blockers.every((blocker) => blocker.closed)).toBe(true);
	});

	test("an assigned ticket and an unassigned one", () => {
		expect(tree.issues.some((candidate) => candidate.claimed)).toBe(true);
		expect(tree.issues.some((candidate) => !candidate.claimed)).toBe(true);
	});

	test("a rankable priority label, an unreadable one, and a ticket with neither", () => {
		expect(readPriority(issue("chain-tip").labels).rank).not.toBeNull();
		expect(readPriority(issue("unread-priority").labels).unread).not.toHaveLength(0);
		const bare = readPriority(issue("no-priority").labels);
		expect(bare).toEqual({ rank: null, unread: [] });
	});

	test("a needs-triage ticket, for the exclusion the filter is given by hand", () => {
		expect(issue("needs-triage").labels).toContain("needs-triage");
		expect(compileLabelFilter({ include: [], exclude: ["needs-triage"] }).admits(issue("needs-triage").labels)).toBe(
			false,
		);
	});

	test("a ticket the default filter excludes, which still blocks one it admits", () => {
		const filter = compileLabelFilter(DEFAULT_LABEL_FILTER);
		expect(filter.admits(issue("excluded-blocker").labels)).toBe(false);
		expect(filter.admits(issue("blocked-by-excluded").labels)).toBe(true);
		expect(issue("blocked-by-excluded").blockedBy).toContain("excluded-blocker");
	});

	// Three hops rather than two: GitHub refuses an edge whose direct reverse already exists, and admits
	// one that closes a longer loop. ADR-0023 records the probe.
	test("a dependency cycle, no two hops of which are a direct pair", () => {
		expect(openDepth("cycle-first")).toBe(Number.POSITIVE_INFINITY);
		const hops = ["cycle-first", "cycle-second", "cycle-third"];
		for (const hop of hops) {
			expect(issue(hop).blockedBy).toHaveLength(1);
			const blocker = issue(hop).blockedBy.join("");
			expect(hops).toContain(blocker);
			expect(issue(blocker).blockedBy).not.toContain(hop);
		}
	});

	test("more open issues than a deliberately low fetch limit returns", () => {
		expect(tree.issues.filter((candidate) => !candidate.closed).length).toBeGreaterThan(10);
	});

	test("exactly one issue reserved for the write path", () => {
		expect(tree.issues.filter((candidate) => candidate.key === "write-target")).toHaveLength(1);
		expect(issue("write-target").claimed).toBe(false);
	});
});
