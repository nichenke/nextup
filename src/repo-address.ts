/**
 * What a repository address looks like, and which authorities are GitHub's. Facts about addresses, depending on
 * neither a reference nor a checkout, so every module that needs one can import this without a cycle.
 *
 * A leaf for a reason rather than for tidiness: `GITHUB_AUTHORITIES` below is a top-level `new Set`, and any
 * module that could import this one in a cycle would risk a module-init-time `isGitHubHost` reading it before it
 * exists — a runtime error with nothing at compile time to warn. Nothing here imports anything, so that cannot
 * arise, which is a structural end to the question rather than a rule to remember (ADR-0025's move).
 */

/** GitHub's own host. The one spelling of it in this codebase; every other reference goes through here. */
export const GITHUB_HOST = "github.com";

/**
 * Every authority GitHub serves, as a git remote or a pasted URL may write it.
 *
 * A flat set rather than a host compared beside a port tested separately, because a port is not a thing this
 * supports: GitHub at some other port is out of scope, so there is nothing to parse a port *for*. Enumerating the
 * endpoints says which are allowed in data rather than leaving a rule to be read off a comparison.
 *
 * Two hosts — the web host and the `ssh.` host GitHub publishes for a firewalled 22 — each written bare or with
 * either default port, since a remote may spell `:22` or `:443` explicitly and both are the port that host already
 * answers on. Six entries, and no pair of host and port outside them.
 *
 * Lower-case throughout, which both producers guarantee: `parseRemote` folds a remote's authority and
 * `normalizeHost` folds a URL's.
 */
const GITHUB_AUTHORITIES: ReadonlySet<string> = new Set([
	GITHUB_HOST,
	`${GITHUB_HOST}:22`,
	`${GITHUB_HOST}:443`,
	`ssh.${GITHUB_HOST}`,
	`ssh.${GITHUB_HOST}:22`,
	`ssh.${GITHUB_HOST}:443`,
]);

/**
 * Whether a git remote's host, or a pasted URL's, is one GitHub answers on.
 *
 * Every caller reads a pass as "this checkout is the GitHub repository at that path" and writes from it — ADR-0038
 * has why the host is the check that matters. That is what the set has to be exact about: an authority this admits
 * wrongly is one whose checkout gets a worktree while GitHub's own API gets the claim, measured on an SSH remote at
 * port 8443 exiting 0.
 */
export function isGitHubHost(host: string): boolean {
	return GITHUB_AUTHORITIES.has(host);
}

// GitHub is always exactly owner/repo; GitLab allows a nested namespace/subgroup, so two or
// more. Either way every segment must be non-empty, rejecting shapes like "/repo", "owner/",
// or "group//repo" that `repo.includes("/")` alone would have let through.
export function isValidRepoPath(tracker: "github" | "gitlab", repo: string): boolean {
	const segments = repo.split("/");
	if (segments.some((segment) => segment === "")) return false;
	return tracker === "github" ? segments.length === 2 : segments.length >= 2;
}
