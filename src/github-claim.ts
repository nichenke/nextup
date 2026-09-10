import { type GitHubClaimCommandInput, githubClaimCommand } from "./command-builders";
import { classifyFailure, collapseFailure } from "./failure-class";
import type { CommandResult, Runner } from "./runner";
import { GITHUB_HOST, type TicketRef, formatTicketRef, isGitHubHost, isValidRepoPath } from "./ticket-ref";

export class GitHubClaimError extends Error {}

export interface GitHubClaimInput {
	readonly runner: Runner;
	/** The ticket to claim, which already names its repository: the pick came from a read that resolved one. */
	readonly ref: TicketRef;
}

/**
 * Claims a GitHub ticket by assigning whoever `gh` is authenticated as, and arbitrates nothing.
 *
 * One write, whose exit status is the whole verdict. Nothing is read back, no identity is compared, and no
 * attempt is made to decide whether two starts of this ticket raced — ADR-0018 has why no sequence of tracker
 * calls could, and why building the partial check anyway would imply a guarantee that does not exist.
 *
 * There is no release path and no rollback either, and a caller must not add one: ADR-0016 has why the ordering
 * makes recovery the ordinary path.
 *
 * @throws GitHubClaimError when the reference is not a claimable GitHub one, or when the write fails. Both
 * failure classes throw, because a failed claim aborts either way; which one it was is what the message says.
 * @throws CommandBuilderError when the reference's key is not a canonical issue number. Not folded into the
 * error above: `resolveTicketRef` can still mint a padded key, so this is reachable rather than impossible, and
 * a stack naming the builder says more than a message about claiming would. ADR-0032, and issue 56 for the mint
 * point.
 */
export function claimGitHubTicket(input: GitHubClaimInput): void {
	const argv = githubClaimCommand(requireClaimable(input.ref));
	const result = input.runner([...argv]);
	if (result.code !== 0) throw failedClaim(input.ref, result);
}

/**
 * The repository and issue to write to, or a refusal. ADR-0032 has why the host check is the one that matters,
 * and why this is the only place a reference's own host is compared against GitHub's.
 */
function requireClaimable(ref: TicketRef): GitHubClaimCommandInput {
	if (ref.tracker !== "github") {
		throw new GitHubClaimError(`${formatTicketRef(ref)} is not a GitHub ticket, and this claims GitHub tickets only`);
	}
	if (ref.repo === null || !isValidRepoPath("github", ref.repo)) {
		throw new GitHubClaimError(`${formatTicketRef(ref)} names no GitHub owner and repository to claim it in`);
	}
	if (ref.host !== null && !isGitHubHost(ref.host)) {
		throw new GitHubClaimError(
			`${formatTicketRef(ref)} is on ${ref.host}, and this claims on ${GITHUB_HOST} only — claiming it here would assign a different repository of the same name`,
		);
	}
	return { repo: ref.repo, key: ref.key };
}

function failedClaim(ref: TicketRef, result: CommandResult): GitHubClaimError {
	// This message is the operator's whole evidence: the run stops here, having already made a worktree. So stdout
	// backs up stderr the way `run` in `test-tree-provision.ts` reads a failed call, and the exit code backs up
	// both — a command can exit non-zero having written to neither stream, which would otherwise abort on a bare
	// colon. Classification still asks stderr alone, which is what it was measured against, so a diagnostic on
	// stdout alone falls through to the loud class.
	const detail = collapseFailure(result.stderr) || collapseFailure(result.stdout) || `no output, exit ${result.code}`;
	const what = formatTicketRef(ref);
	// Not "the request is wrong": a missing or unauthenticated `gh`, and a repository we cannot write to, both
	// land here, and none of the three is fixed by editing the request or by trying again.
	return classifyFailure(result.stderr) === "defect"
		? new GitHubClaimError(`claiming ${what} failed with something a retry will not fix: ${detail}`)
		: new GitHubClaimError(`claiming ${what} failed because the tracker could not be reached: ${detail}`);
}
