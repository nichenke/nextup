import { type RemoteAddress, resolveOriginRemote } from "./git-remote";
import type { Runner } from "./runner";
import { GITHUB_HOST, isGitHubHost, isValidRepoPath } from "./repo-address";

/**
 * The brand's key. A real symbol rather than a `declare`d one, so `checkoutIdentityOf` can actually set it:
 * a type-only declaration makes the property unnameable at runtime too, and the factory then builds a value
 * that fails the type it claims. Not exported, which is what makes the brand nominal — no other module can
 * spell this key, so no other module can make one of these without a cast.
 */
const checkoutIdentity: unique symbol = Symbol("checkout-identity");

/**
 * Which GitHub repository the checkout a command was invoked in *is*.
 *
 * About the checkout, not about a ticket: `ticketId` already uses "identity" for a ticket's graph key, and these
 * are different questions. `CONTEXT.md` holds both terms apart.
 *
 * Branded and resolved-or-nothing: `resolveCheckoutIdentity` is the only producer, and there is no unknown arm.
 * ADR-0040 has why both, and ADR-0039 the five checks the pair replaced.
 */
export interface CheckoutIdentity {
	readonly [checkoutIdentity]: true;
	/** `owner/repo`, folded to lower case for the reason `githubTicketRef` gives, so comparisons are `===`. */
	readonly repo: string;
}

/**
 * How a caller reports that the checkout could not be identified.
 *
 * Passed in rather than thrown from here, because each caller raises its own class and each encodes a different
 * recovery: `cli.ts` reads the class to decide what a failed start leaves open, `ticket-ref.ts` raises a bad
 * reference, and `scripts/reconstruct.ts` a run that cannot be made. ADR-0040 has why.
 */
export type RefuseCheckout = (reason: string) => Error;

/**
 * The GitHub repository the checkout at `directory` is, or a refusal.
 *
 * Reaches `resolveOriginRemote` through `checkoutRemote`, which is that function's only caller, so "which
 * repository am I standing in" is computed in one place and threaded rather than re-asked. Both failures are
 * refusals: a remote that will not resolve leaves the question unanswered, and a remote on any other host
 * answers it with a repository this tool cannot act on — no command this tool issues puts a hostname in `gh`'s
 * `--repo`, so `owner/repo` read off a GitHub Enterprise or GitLab checkout addresses whatever sits at that
 * path on GitHub instead.
 *
 * @throws whatever `refuse` builds, always as an Error.
 */
export function resolveCheckoutIdentity(runner: Runner, directory: string, refuse: RefuseCheckout): CheckoutIdentity {
	const origin = checkoutRemote(runner, directory, refuse);
	if (!isGitHubHost(origin.host)) {
		throw refuse(
			`this checkout's origin remote points at ${origin.host} rather than ${GITHUB_HOST}, so ${origin.repo} here is a repository of the same name somewhere else entirely — this works on ${GITHUB_HOST} only, so run it in a checkout of one${aliasNote(origin.host)}`,
		);
	}
	if (!isValidRepoPath("github", origin.repo)) {
		throw refuse(`this checkout's origin remote names ${origin.repo}, which is not one GitHub owner and repository`);
	}
	return checkoutIdentityOf(origin.repo.toLowerCase());
}

function checkoutIdentityOf(repo: string): CheckoutIdentity {
	return { [checkoutIdentity]: true, repo };
}

/**
 * What a host refusal adds when the host carries no dot.
 *
 * The one shape whose answer is a host nobody configured: a remote URL that a `url.<base>.insteadOf` rule is
 * what expands, in whichever scope that rule sits. The refusal is right either way — an alias is not evidence of a GitHub checkout — but without
 * this it reports a tracker at that host. ADR-0041 has the other shapes the two commands differ over.
 *
 * Nothing here decides on the dot: a miss leaves the refusal as it would have been. ADR-0041 has what the
 * test misses and why that is affordable.
 */
function aliasNote(host: string): string {
	return host.includes(".")
		? ""
		: ` (${host} has no dot in it, which is the shape a url.<base>.insteadOf alias leaves behind — this reads the URL the repository's own config spells, and does not apply that rewriting)`;
}

/**
 * The repository path the remote of the checkout at `directory` spells, on whatever host, as spelled.
 *
 * The one reading that is not a `CheckoutIdentity`, and it has exactly one caller: the bare `glab:<number>`
 * short form. A GitLab instance can be any host, so there is no host test to pass and nothing to fold — ADR-0039
 * has why leaving GitLab's case semantics undecided is safe, and ADR-0040 why this is not an identity.
 *
 * Having no host test also means this is the one path where a `url.<base>.insteadOf` alias cannot be refused —
 * nothing distinguishes one from a short hostname. ADR-0041 bounds what that can cost.
 *
 * @throws whatever `refuse` builds, when the remote cannot be resolved.
 */
export function resolveCheckoutRepoPath(runner: Runner, directory: string, refuse: RefuseCheckout): string {
	return checkoutRemote(runner, directory, refuse).repo;
}

function checkoutRemote(runner: Runner, directory: string, refuse: RefuseCheckout): RemoteAddress {
	const origin = resolveOriginRemote(runner, directory);
	if (origin === null) {
		throw refuse(
			`the origin remote of ${directory} could not be resolved from that checkout's own git config — set an origin remote there, or run this somewhere that has one`,
		);
	}
	return origin;
}
