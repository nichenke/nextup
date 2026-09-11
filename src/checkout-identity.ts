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
 * Branded, so `resolveCheckoutIdentity` is the only thing that can produce one — only this module can name the
 * symbol. Without that the type is structurally just `{ repo: string }`, and the value this module deliberately
 * does *not* hand to a write, `resolveCheckoutRepoPath`'s unfolded path off any host, could be passed straight
 * into the claim as one. ADR-0039 has why a write takes this as a parameter at all, which is the guarantee the
 * brand is what makes true.
 *
 * It exists only when resolved. There is no unknown arm and no nullable field, because every reader is deciding
 * whether a write may happen — and "we could not tell" has exactly one safe answer there, which is to refuse.
 * ADR-0038 has the five checks this and the reference union replaced, and the order they were added in.
 */
export interface CheckoutIdentity {
	readonly [checkoutIdentity]: true;
	/** `owner/repo`, folded to lower case, so a comparison against a reference is `===` rather than a fold. */
	readonly repo: string;
}

/**
 * How a caller reports that the checkout could not be identified.
 *
 * Passed in rather than thrown from here, because each caller raises its own class and each encodes a different
 * recovery: `cli.ts` reads the class to decide what a failed start leaves open, `ticket-ref.ts` raises a bad
 * reference, and `scripts/reconstruct.ts` a run that cannot be made. One shared class would collapse those.
 * ADR-0039 has why one resolver with several wordings is not the same as several checks.
 */
export type RefuseCheckout = (reason: string) => Error;

/**
 * The GitHub repository this checkout is, or a refusal.
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
export function resolveCheckoutIdentity(runner: Runner, refuse: RefuseCheckout): CheckoutIdentity {
	const origin = checkoutRemote(runner, refuse);
	if (!isGitHubHost(origin.host)) {
		throw refuse(
			`this checkout's origin remote points at ${origin.host} rather than ${GITHUB_HOST}, so ${origin.repo} here is a repository of the same name somewhere else entirely`,
		);
	}
	if (!isValidRepoPath("github", origin.repo)) {
		throw refuse(`this checkout's origin remote names ${origin.repo}, which is not one GitHub owner and repository`);
	}
	return checkoutIdentityOf(origin.repo.toLowerCase());
}

/**
 * A `CheckoutIdentity` for a repository path a caller has established by some other means than reading this
 * checkout's remote — a test standing a run somewhere, and nothing in production.
 *
 * It validates and folds exactly as the resolver does, so it is a second door into the same room rather than a
 * way past the brand. Exported because the brand is otherwise unnameable outside this module, which is the point.
 *
 * @throws whatever `refuse` builds, when the path is not one GitHub owner and repository.
 */
export function checkoutIdentityFor(repo: string, refuse: RefuseCheckout): CheckoutIdentity {
	if (!isValidRepoPath("github", repo)) {
		throw refuse(`${repo} is not one GitHub owner and repository, so it cannot be a checkout to write in`);
	}
	return checkoutIdentityOf(repo.toLowerCase());
}

function checkoutIdentityOf(repo: string): CheckoutIdentity {
	return { [checkoutIdentity]: true, repo };
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
