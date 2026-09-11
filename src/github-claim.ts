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
	 * It is a parameter so that a caller cannot write the claim without having resolved it — the split this
	 * exists to prevent is the claim landing in one repository while the worktree and the session are made in
	 * another, and a check the caller has to remember is what let that reach review three times. ADR-0039.
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
 * @throws CommandBuilderError from the builder's own canonical-key assertion, which no input reaching here can
 * trip: `githubTicketRef` refuses a padded key at construction. ADR-0038 has why the builder keeps it anyway.
 */
export function claimGitHubTicket(input: GitHubClaimInput): void {
	requireThisCheckout(input.ref, input.checkout);
	const result = input.runner([...githubClaimCommand(input.ref)]);
	if (result.code !== 0) throw failedClaim(input.ref, result);
}

/**
 * Refuses a claim on a ticket that lives somewhere other than the checkout this run is standing in.
 *
 * A plain `===`, because both sides were folded to lower case where they were built. Last of several
 * refusals rather than the only one — `cli.ts` makes the same comparison before anything is written, so
 * reaching this one means an earlier caller was skipped. It is here anyway because this is the write, and
 * ADR-0039 has why the invariant lives with the thing it protects rather than with whoever remembers it.
 */
function requireThisCheckout(ref: GitHubTicketRef, checkout: CheckoutIdentity): void {
	if (ref.repo === checkout.repo) return;
	throw new GitHubClaimError(
		`${formatTicketRef(ref)} is in ${ref.repo} and this checkout is ${checkout.repo}, so it was not claimed — the claim would land there while the worktree and the session were made here`,
	);
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
