import { type RemoteAddress, resolveOriginRemote } from "./git-remote";
import type { Runner } from "./runner";
import { GITHUB_HOST, isGitHubHost } from "./ticket-ref";

/**
 * Which GitHub repository the checkout a command was invoked in *is*.
 *
 * About the checkout, not about a ticket: `ticketId` already uses "identity" for a ticket's graph key, and these
 * are different questions. `CONTEXT.md` holds both terms apart.
 *
 * It exists only when resolved. There is no unknown arm and no null field, because every reader of this value
 * is deciding whether a write may happen — and "we could not tell" has exactly one safe answer there, which is
 * to refuse. ADR-0039 has the five checks this replaced and the order they were added in.
 */
export interface CheckoutIdentity {
	/** `owner/repo`, folded to lower case, so a comparison against a reference is `===` rather than a fold. */
	readonly repo: string;
}

/**
 * How a caller reports that the checkout could not be identified.
 *
 * Passed in rather than thrown from here, because the three callers raise three different classes and each
 * encodes a different recovery: `cli.ts` reads the class to decide what a failed start leaves open, the read
 * adapter's is a failed read, and the resolver's is a bad reference. ADR-0032 is explicit that collapsing them
 * would be wrong, and ADR-0039 has why one resolver with three wordings is not the same as three checks.
 */
export type RefuseCheckout = (reason: string) => Error;

/**
 * The GitHub repository this checkout is, or a refusal.
 *
 * The one caller of `resolveOriginRemote`, so that "which repository am I standing in" is computed in one place
 * and threaded rather than re-asked. Both failures are refusals: a remote that will not resolve leaves the
 * question unanswered, and a remote on any other host answers it with a repository this tool cannot act on —
 * `gh` carries no hostname in `--repo`, so `owner/repo` from a GitHub Enterprise or GitLab checkout addresses
 * whatever sits at that path on GitHub instead.
 *
 * @throws whatever `refuse` builds, always as an Error.
 */
export function resolveCheckoutIdentity(runner: Runner, refuse: RefuseCheckout): CheckoutIdentity {
	const origin = checkoutRemote(runner, refuse);
	if (!isGitHubHost(origin.host)) {
		throw refuse(
			`this checkout's origin remote points at ${origin.host} rather than ${GITHUB_HOST}, so ${origin.repo} here is a repository of the same name somewhere else entirely`,
		);
	}
	return { repo: origin.repo.toLowerCase() };
}

/**
 * The repository path this checkout's remote spells, on whatever host, as spelled.
 *
 * The one reading that is not a `CheckoutIdentity`, and it has exactly one caller: the bare `glab:<number>`
 * short form. A GitLab instance can be any host, so there is no host test to pass and nothing to fold — issue 15
 * owns whether GitLab resolves a path case-insensitively, and ADR-0038 has why leaving that undecided is safe.
 *
 * @throws whatever `refuse` builds, when the remote cannot be resolved.
 */
export function resolveCheckoutRepoPath(runner: Runner, refuse: RefuseCheckout): string {
	return checkoutRemote(runner, refuse).repo;
}

function checkoutRemote(runner: Runner, refuse: RefuseCheckout): RemoteAddress {
	const origin = resolveOriginRemote(runner);
	if (origin === null) throw refuse("the working directory's git remote could not be resolved");
	return origin;
}
