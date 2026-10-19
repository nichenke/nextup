import { describe, expect, test } from "bun:test";
import type { Runner } from "./runner";
import { WARNING_PREFIX, renderWorktree } from "./worktree-output";
import { type Base, type WorktreeOutcome, resolveBase } from "./worktree";

const COMMON = { path: "/repo/.worktrees/reader-8", branch: "feature/reader-8", primary: "/repo", warnings: [] } as const;
const NONE = { kind: "none" } as const;

const CREATED: WorktreeOutcome = { ...COMMON, kind: "created", command: ["git", "worktree", "add"], base: NONE };
const CHECKED_OUT: WorktreeOutcome = { ...COMMON, kind: "checked-out", command: ["git", "worktree", "add"], base: NONE };
const ATTACHED: WorktreeOutcome = { ...COMMON, kind: "attached", command: null, base: NONE };

const SIDE_COMMIT = "e4477a4c8f24f4e1c0337fab27ee66b58e4a4fc9";
const answersSide: Runner = () => ({ code: 0, stdout: `${SIDE_COMMIT}\n`, stderr: "" });
const SIDE = resolveBase(answersSide, "/repo", "side");

const FROM_SIDE: WorktreeOutcome = { ...CREATED, base: { kind: "applied", base: SIDE } };
const NOT_APPLIED = /^warning: .*--base side was not applied/m;

describe("renderWorktree", () => {
	test("reads the three outcomes as three different things", () => {
		const rendered = [CREATED, CHECKED_OUT, ATTACHED].map(renderWorktree);

		expect(new Set(rendered).size).toBe(3);
	});

	test("says a new branch was cut", () => {
		expect(renderWorktree(CREATED)).toBe("created /repo/.worktrees/reader-8\n  on feature/reader-8, a new branch\n");
	});

	test("names the base a new branch was cut from, and the commit it was pinned to", () => {
		expect(renderWorktree(FROM_SIDE)).toBe(
			"created /repo/.worktrees/reader-8\n  on feature/reader-8, a new branch from side at e4477a4\n",
		);
	});

	test("distinguishes adopting a branch that already existed from cutting one", () => {
		expect(renderWorktree(CHECKED_OUT)).toContain("already existed");
		expect(renderWorktree(CHECKED_OUT)).not.toContain("a new branch");
	});

	test("says nothing was made when it attached to what was there", () => {
		expect(renderWorktree(ATTACHED)).toBe("attached to /repo/.worktrees/reader-8\n  on feature/reader-8, where it already was\n");
	});

	test("warns that a base was not applied, on both routes onto a branch that already existed", () => {
		const notApplied = { kind: "not-applied", base: SIDE } as const;
		const onto: readonly WorktreeOutcome[] = [
			{ ...COMMON, kind: "checked-out", command: ["git", "worktree", "add"], base: notApplied },
			{ ...COMMON, kind: "attached", command: null, base: notApplied },
		];

		for (const outcome of onto) {
			const rendered = renderWorktree(outcome);
			expect(rendered).toMatch(NOT_APPLIED);
			expect(rendered).toContain("feature/reader-8 already existed, so it was left where it was");
		}
	});

	test("names the base an existing branch already contains in its own line, and warns about nothing", () => {
		const onBase = { kind: "already-on-base", base: SIDE } as const;

		expect(renderWorktree({ ...CHECKED_OUT, kind: "checked-out", base: onBase })).toBe(
			"checked out /repo/.worktrees/reader-8\n  on feature/reader-8, which already existed, and already contains side at e4477a4\n",
		);
		expect(renderWorktree({ ...ATTACHED, kind: "attached", base: onBase })).toBe(
			"attached to /repo/.worktrees/reader-8\n  on feature/reader-8, where it already was, and already contains side at e4477a4\n",
		);
	});

	test("keeps the not-applied warning beside any other, each on its own prefixed line", () => {
		const outcome: WorktreeOutcome = { ...ATTACHED, warnings: ["drifted"], base: { kind: "not-applied", base: SIDE } };
		const warnings = renderWorktree(outcome).trimEnd().split("\n").filter((line) => line.startsWith(WARNING_PREFIX));

		expect(warnings).toHaveLength(2);
		expect(warnings[1]).toBe(`${WARNING_PREFIX}drifted`);
	});

	test("says nothing about a base where none was given or the one given was applied", () => {
		for (const outcome of [CREATED, CHECKED_OUT, ATTACHED, FROM_SIDE]) {
			expect(renderWorktree(outcome)).not.toContain("--base");
		}
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
		expect(renderWorktree(FROM_SIDE)).not.toContain(WARNING_PREFIX);
	});

	test("cannot be handed an outcome whose base contradicts its route, or a base nothing resolved", () => {
		const applied = { kind: "applied", base: SIDE } as const;
		const notApplied = { kind: "not-applied", base: SIDE } as const;
		// @ts-expect-error an attach left the branch where it was, so it cannot have applied a base
		const attachedApplied: WorktreeOutcome = { ...ATTACHED, base: applied };
		// @ts-expect-error a checkout of an existing branch cannot have applied one either
		const checkedOutApplied: WorktreeOutcome = { ...CHECKED_OUT, kind: "checked-out", base: applied };
		// @ts-expect-error a new branch was cut, so the base given to it was applied
		const createdNotApplied: WorktreeOutcome = { ...CREATED, kind: "created", base: notApplied };
		// @ts-expect-error nor was it already there to contain the base
		const createdOnBase: WorktreeOutcome = { ...CREATED, kind: "created", base: { kind: "already-on-base", base: SIDE } };
		// @ts-expect-error only resolveBase makes a Base, so its commit is one git named
		const forged: Base = { given: "side", commit: SIDE_COMMIT };
		// @ts-expect-error nor does a spread of one that was resolved, which would keep the ref and swap the commit
		const respelled: Base = { ...SIDE, commit: "0".repeat(40) };

		expect([attachedApplied, checkedOutApplied, createdNotApplied, createdOnBase, forged, respelled]).toHaveLength(6);
		expect(JSON.parse(JSON.stringify(SIDE))).toEqual({ given: "side", commit: SIDE_COMMIT });
	});

	test("ends in exactly one newline, as renderSelection does", () => {
		for (const outcome of [CREATED, CHECKED_OUT, ATTACHED, FROM_SIDE]) {
			expect(renderWorktree(outcome)).toMatch(/[^\n]\n$/);
		}
	});
});
