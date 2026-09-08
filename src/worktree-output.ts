import type { WorktreeOutcome } from "./worktree";

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

/**
 * What ensuring the worktree did, as a person reads it.
 *
 * Each of the three outcomes reads differently, which is the point rather than a nicety: `created` and
 * `checked-out` both made a worktree at a path that was not there, and only the branch tells them apart
 * — so a run that cut a new branch and one that adopted a branch somebody else pushed must not print
 * the same sentence.
 */
export function renderWorktree(outcome: WorktreeOutcome): string {
	const lines = [`${DID[outcome.kind]} ${outcome.path}`, `  on ${branchPhrase(outcome)}`];
	for (const warning of outcome.warnings) lines.push(`${WARNING_PREFIX}${warning}`);
	return `${lines.join("\n")}\n`;
}

function branchPhrase(outcome: WorktreeOutcome): string {
	if (outcome.kind === "created") return `${outcome.branch}, a new branch`;
	if (outcome.kind === "checked-out") return `${outcome.branch}, which already existed`;
	return `${outcome.branch}, where it already was`;
}
