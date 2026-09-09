import { describe, expect, test } from "bun:test";
import { WARNING_PREFIX, renderWorktree } from "./worktree-output";
import type { WorktreeOutcome } from "./worktree";

const BASE = { path: "/repo/.worktrees/reader-8", branch: "feature/reader-8", primary: "/repo", warnings: [] } as const;

const CREATED: WorktreeOutcome = { ...BASE, kind: "created", command: ["git", "worktree", "add"] };
const CHECKED_OUT: WorktreeOutcome = { ...BASE, kind: "checked-out", command: ["git", "worktree", "add"] };
const ATTACHED: WorktreeOutcome = { ...BASE, kind: "attached", command: null };

describe("renderWorktree", () => {
	test("reads the three outcomes as three different things", () => {
		const rendered = [CREATED, CHECKED_OUT, ATTACHED].map(renderWorktree);

		expect(new Set(rendered).size).toBe(3);
	});

	test("says a new branch was cut", () => {
		expect(renderWorktree(CREATED)).toBe("created /repo/.worktrees/reader-8\n  on feature/reader-8, a new branch\n");
	});

	test("distinguishes adopting a branch that already existed from cutting one", () => {
		expect(renderWorktree(CHECKED_OUT)).toContain("already existed");
		expect(renderWorktree(CHECKED_OUT)).not.toContain("a new branch");
	});

	test("says nothing was made when it attached to what was there", () => {
		expect(renderWorktree(ATTACHED)).toBe("attached to /repo/.worktrees/reader-8\n  on feature/reader-8, where it already was\n");
	});

	test("carries every warning on its own prefixed line, so a caller can grep for them", () => {
		const drifted: WorktreeOutcome = { ...CREATED, warnings: ["the primary checkout /repo is on wip, not on main", "and another"] };
		const lines = renderWorktree(drifted).trimEnd().split("\n");

		expect(lines.filter((line) => line.startsWith(WARNING_PREFIX))).toEqual([
			`${WARNING_PREFIX}the primary checkout /repo is on wip, not on main`,
			`${WARNING_PREFIX}and another`,
		]);
	});

	test("emits no warning line when there is nothing to warn about", () => {
		expect(renderWorktree(CREATED)).not.toContain(WARNING_PREFIX);
	});

	test("ends in exactly one newline, as renderSelection does", () => {
		for (const outcome of [CREATED, CHECKED_OUT, ATTACHED]) {
			expect(renderWorktree(outcome)).toMatch(/[^\n]\n$/);
		}
	});
});
