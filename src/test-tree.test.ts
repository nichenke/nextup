import { describe, expect, test } from "bun:test";
import { readPriority } from "./priority";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import { GITHUB_TEST_TREE, type TestTreeSpec, TestTreeError, validateTestTree } from "./test-tree";

const tree = GITHUB_TEST_TREE;

/**
 * The fetch limit a future truncation test is expected to set, named so the assertion below says what the
 * number is for. Nothing enforces the coupling, because the limit it stands in for does not exist yet: the
 * read adapter owns it, and this is the slice before that.
 *
 * Deliberately not derived from `LIST_LIMIT` in `test-tree-provision.ts`, which is a different quantity —
 * that one is set high so provisioning's own listing cannot truncate, and tying the two together would make
 * raising one silently shrink the shape the other is asserting.
 */
const LOW_FETCH_LIMIT = 10;

function issue(key: string) {
	const found = tree.issues.find((candidate) => candidate.key === key);
	if (found === undefined) throw new Error(`no issue keyed ${key}`);
	return found;
}

/**
 * How many hops of open blockers separate `key` from an issue nothing open blocks, or
 * `POSITIVE_INFINITY` when the walk re-enters a key it has already visited — which is how a cycle is
 * told apart from a deep chain here.
 */
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

	// Reconciliation matches on title, not on key, so two issues sharing a title collapse to one number:
	// the tree gains an issue no key reaches, and every later run oscillates between the two specs.
	// The fourth identity in the spec, and the last one left unchecked. Two definitions of one name cannot both
	// be satisfied: `--force` writes each in turn, so every run sets the colour twice and the spec stays wrong.
	test("refuses two definitions of the same label", () => {
		const spec: TestTreeSpec = {
			...tree,
			labels: [...tree.labels, { name: "P0", color: "000000" }],
		};
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	test("refuses a repeated title, which is the identity the tracker is matched on", () => {
		const spec: TestTreeSpec = {
			...tree,
			issues: [issue("no-priority"), { ...issue("chain-base"), title: issue("no-priority").title }],
		};
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	// A key naming its own issue is in `keys`, so the resolvable-blocker check passes it through — and GitHub
	// then refuses the edge mid-provision, which is the fail-after-partial-write this function exists to
	// prevent.
	test("refuses an issue that blocks itself", () => {
		const spec: TestTreeSpec = { ...tree, issues: [{ ...issue("chain-tip"), blockedBy: ["chain-tip"] }] };
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	// GitHub refuses any edge whose direct reverse already exists. Self-block is that rule at length one and a
	// mutual pair is it at length two, so checking only the first leaves the second to fail partway through
	// provisioning — and two hops is the obvious way to write a cycle, three being the non-obvious probe result.
	test("refuses two issues that block each other", () => {
		const spec: TestTreeSpec = {
			...tree,
			issues: [
				{ ...issue("chain-base"), blockedBy: ["chain-middle"] },
				{ ...issue("chain-middle"), blockedBy: ["chain-base"] },
			],
		};
		expect(() => validateTestTree(spec)).toThrow(TestTreeError);
	});

	// The `Set` used for the mutual-pair check collapses a repeat, so validation saw nothing wrong. Provisioning
	// reads the present edges once before its loop, so both copies look absent: two writes and two report lines
	// for the single edge GitHub stores.
	test("refuses a blocker named twice by the same issue", () => {
		const spec: TestTreeSpec = {
			...tree,
			issues: [issue("chain-base"), { ...issue("chain-middle"), blockedBy: ["chain-base", "chain-base"] }],
		};
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
	// Both the property and the wiring: the depth is what ticket 35 asks for and survives a restructured
	// chain, while the explicit edges mean a bug in `openDepth` cannot make this pass for the wrong reason.
	test("a chain of open blockers at least two deep", () => {
		expect(openDepth("chain-tip")).toBeGreaterThanOrEqual(2);
		expect(issue("chain-tip").blockedBy).toEqual(["chain-middle"]);
		expect(issue("chain-middle").blockedBy).toEqual(["chain-base"]);
		expect(issue("chain-base").blockedBy).toEqual([]);
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

	// Without this the minimum-rank branch of `readPriority` is unreachable from any recording, and so is the
	// question of whether an unreadable label is still reported once a rank has been found. Both would be left
	// to hand-authored scenario inputs, which ADR-0019 admits for how the ladder ranks but not for what a
	// tracker emits — and a tracker does emit this, because labels are a set.
	test("a ticket carrying several priority labels at once", () => {
		const reading = readPriority(issue("several-priorities").labels);
		expect(reading.rank).toBe(0);
		expect(reading.unread).toEqual(["priority: high"]);
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

	// Three hops rather than two, because GitHub refuses a direct pair — ADR-0023 has the probe.
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
		expect(tree.issues.filter((candidate) => !candidate.closed).length).toBeGreaterThan(LOW_FETCH_LIMIT);
	});

	test("exactly one issue reserved for the write path", () => {
		expect(tree.issues.filter((candidate) => candidate.key === "write-target")).toHaveLength(1);
		expect(issue("write-target").claimed).toBe(false);
	});
});
