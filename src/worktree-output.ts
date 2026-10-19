import type { Base, WorktreeOutcome } from "./worktree";

/**
 * The prefix every warning line carries, so a caller can find them with `grep '^warning: '` rather than
 * by matching the prose after it. `DEGRADED_PREFIX` in `selection-output.ts` is the same contract for
 * the same reason: the prose is free to change, the prefix is not.
 */
export const WARNING_PREFIX = "warning: ";

const DID: Record<WorktreeOutcome["kind"], string> = {
	created: "created",
	"checked-out": "checked out",
	attached: "attached to",
};

const SHORT_COMMIT = 7;

/**
 * What ensuring the worktree did, as a person reads it.
 *
 * Each of the three outcomes reads differently, which is the point rather than a nicety: `created` and
 * `checked-out` both made a worktree at a path that was not there, and only the branch tells them apart
 * — so a run that cut a new branch and one that adopted a branch somebody else pushed must not print
 * the same sentence.
 *
 * A base that was not applied is a warning line, because the run did something other than what was asked
 * and still succeeded. A branch already on the base gets none, since the run did what was asked. ADR-0044.
 */
export function renderWorktree(outcome: WorktreeOutcome): string {
	return `${DID[outcome.kind]} ${outcome.path}\n  on ${branchPhrase(outcome)}\n${renderWorktreeWarnings(outcome)}`;
}

/**
 * The warning lines alone, each ending in a newline, or `""` where there are none.
 */
export function renderWorktreeWarnings(outcome: WorktreeOutcome): string {
	const lines: string[] = [];
	if (outcome.base.kind === "not-applied") {
		lines.push(
			`${WARNING_PREFIX}--base ${outcome.base.base.given} was not applied: ${outcome.branch} already existed, so it was left where it was`,
		);
	}
	for (const warning of outcome.warnings) lines.push(`${WARNING_PREFIX}${warning}`);
	return lines.map((line) => `${line}\n`).join("");
}

function branchPhrase(outcome: WorktreeOutcome): string {
	if (outcome.kind === "created") {
		if (outcome.base.kind === "none") return `${outcome.branch}, a new branch`;
		return `${outcome.branch}, a new branch from ${pinned(outcome.base.base)}`;
	}
	const contains = outcome.base.kind === "already-on-base" ? `, and already contains ${pinned(outcome.base.base)}` : "";
	if (outcome.kind === "checked-out") return `${outcome.branch}, which already existed${contains}`;
	return `${outcome.branch}, where it already was${contains}`;
}

function pinned(base: Base): string {
	return `${base.given} at ${base.commit.slice(0, SHORT_COMMIT)}`;
}
