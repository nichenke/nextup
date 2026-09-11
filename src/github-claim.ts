import type { CheckoutIdentity } from "./checkout-identity";
import { githubClaimCommand } from "./command-builders";
import { classifyFailure, failureDetail } from "./failure-class";
import type { CommandResult, Runner } from "./runner";
import { type GitHubTicketRef, type TicketRef, formatTicketRef } from "./ticket-ref";

export class GitHubClaimError extends Error {}

export interface GitHubClaimInput {
	readonly runner: Runner;
	/** The ticket to claim, already a GitHub reference: `githubTicketTarget` is what narrows one, upstream. */
	readonly ref: GitHubTicketRef;
	/**
	 * The repository this run is standing in, required rather than looked up here.
	 *
	 * A parameter so that a caller cannot write the claim without having resolved it — the split this exists to
	 * prevent is the claim landing in one repository while the worktree and the session are made in another,
	 * and a check the caller has to remember is what let that reach review three times. ADR-0039.
	 */
	readonly checkout: CheckoutIdentity;
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
 * @throws GitHubClaimError when the ticket is not in this checkout, or when the write fails. Both failure
 * classes throw, because a failed claim aborts either way; which one it was is what the message says.
 * @throws TicketRefError from the builder's own canonical-key assertion, which no input reaching here can trip:
 * `githubTicketRef` refuses a padded key at construction. ADR-0038 has why the builder keeps it anyway.
 */
export function claimGitHubTicket(input: GitHubClaimInput): void {
	requireThisCheckout(input.ref, input.checkout);
	const result = input.runner([...githubClaimCommand(input.ref)]);
	if (result.code !== 0) throw failedClaim(input.ref, result);
}

/**
 * Why this ticket is not one to act on from this checkout, or null where it is.
 *
 * The split it catches is the claim landing in one repository while the worktree and the session are made in
 * another. A stale local remote is the reachable way there: a repository renamed on GitHub keeps answering
 * under its new name, and `requireOneRepository` deliberately tolerates that, so the references a ranked run
 * holds name a repository this checkout is not. ADR-0039.
 *
 * Here rather than beside `CheckoutIdentity`, which is the data it reads and where review first put it: moving
 * it there makes `checkout-identity.ts` import `formatTicketRef`, which is the `ticket-ref.ts` cycle
 * `repo-address.ts` exists to have removed. A module graph that stays acyclic is worth more than a function
 * living beside the type it reads.
 *
 * The reason comes back rather than being thrown, the way `githubTicketTarget`'s does and for the same reason:
 * `cli.ts` asks before anything is written and raises a `StartError`, this file asks again at the write and
 * raises its own class, and one shared error would collapse the two recoveries.
 */
export function outsideThisCheckout(ref: GitHubTicketRef, checkout: CheckoutIdentity): string | null {
	if (ref.repo === checkout.repo) return null;
	return `${formatTicketRef(ref)} is in ${ref.repo} and this checkout is ${checkout.repo} — the claim would land there while the worktree and the session were made here`;
}

/**
 * The same question at the write, where it cannot be forgotten. `cli.ts` refuses earlier so that nothing is
 * created first; reaching this one means that caller was skipped, and it is a write, so it asks anyway.
 */
function requireThisCheckout(ref: GitHubTicketRef, checkout: CheckoutIdentity): void {
	const outside = outsideThisCheckout(ref, checkout);
	if (outside !== null) throw new GitHubClaimError(`${outside}, so it was not claimed`);
}

function failedClaim(ref: TicketRef, result: CommandResult): GitHubClaimError {
	const detail = failureDetail(result);
	const what = formatTicketRef(ref);
	// Not "the request is wrong": a missing or unauthenticated `gh`, and a repository we cannot write to, both
	// land here, and none of the three is fixed by editing the request or by trying again.
	return classifyFailure(result.stderr) === "defect"
		? new GitHubClaimError(`claiming ${what} failed with something a retry will not fix: ${detail}`)
		: new GitHubClaimError(`claiming ${what} failed because the tracker could not be reached: ${detail}`);
}
