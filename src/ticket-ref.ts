import { type Runner, defaultRunner } from "./runner";
import { type CheckoutIdentity, type RefuseCheckout, resolveCheckoutIdentity, resolveCheckoutRepoPath } from "./checkout-identity";
import { GITHUB_HOST, isGitHubHost, isValidRepoPath } from "./repo-address";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";

export type Tracker = "github" | "gitlab" | "jira";

/**
 * A GitHub ticket, valid by construction: `githubTicketRef` is the only way to make one and refuses anything
 * this tool cannot act on.
 *
 * There is no `host` field, and that absence is the scope decision rather than a saving — ADR-0038. GitHub
 * Enterprise is out of scope, so a reference on any other host is not a GitHub reference this can represent,
 * and a caller cannot be handed one to check.
 */
export interface GitHubTicketRef {
	readonly tracker: "github";
	/** `owner/repo`, two non-empty segments, folded to lower case — ADR-0038 has why the fold is here. */
	readonly repo: string;
	/** A canonical issue number: no leading zeros, and never a bare `0`. */
	readonly key: string;
}

/**
 * A GitLab ticket. Unlike the GitHub variant this carries a host, because a self-hosted instance can be any
 * host and the host is what tells two instances apart.
 *
 * Its repository path is kept as spelled: whether GitLab resolves a path case-insensitively is undecided here
 * and belongs to nichenke/nextup issue 15, which wants a cited source rather than an inference from GitHub's
 * behaviour.
 */
export interface GitLabTicketRef {
	readonly tracker: "gitlab";
	/** `namespace/project`, two or more non-empty segments, as spelled. */
	readonly repo: string;
	/** Known only when parsed from a pasted URL; a short form resolved from a remote carries none. */
	readonly host: string | null;
	readonly key: string;
}

/** A Jira ticket, which has no repository: a Jira key is scoped by its project prefix and its tenant. */
export interface JiraTicketRef {
	readonly tracker: "jira";
	/** Known only when parsed from a pasted URL. `ticket.ts` has what an absent one costs across tenants. */
	readonly host: string | null;
	readonly key: string;
}

/**
 * The normalized identity of a single ticket, as a union over trackers rather than one shape with a
 * discriminant that discriminates nothing.
 *
 * Every variant is built by a constructor in this module that validates and normalizes it, so a consumer
 * receives a reference it does not have to check. ADR-0038 records what that replaced: five checks, added
 * across three review rounds, each asking a consumer to re-derive what the type can now state.
 */
export type TicketRef = GitHubTicketRef | GitLabTicketRef | JiraTicketRef;

export class TicketRefError extends Error {}

/**
 * The tracker host a reference carries, or null where it carries none.
 *
 * A function rather than a field every variant declares, because the GitHub variant deliberately has no host
 * to read. `ticketId` and `compareTicketRefs` are the only callers, and both want a whole-reference reading.
 */
export function refHost(ref: TicketRef): string | null {
	return ref.tracker === "github" ? null : ref.host;
}

/** The repository a reference names, or null for a tracker that has none. The reading `refHost` is for hosts. */
export function refRepo(ref: TicketRef): string | null {
	return ref.tracker === "jira" ? null : ref.repo;
}

/**
 * The GitHub reference for `repo` and `key`, normalized, or a refusal.
 *
 * The only way to make a `GitHubTicketRef`, which is what lets every consumer stop checking. Three things are
 * settled here and nowhere else, and ADR-0038 has the measurement behind each:
 *
 * - The repository path is exactly two non-empty segments. GitHub has no subgroups, so a third segment names
 *   something else — and `gh` reads `--repo` as `[HOST/]OWNER/REPO`, so a three-segment value is a host.
 * - The path is folded to lower case, because GitHub resolves it case-insensitively while a git remote records
 *   whatever was typed. Unfolded, `NicHenke/NextUp` and `nichenke/nextup` are two graph keys for one ticket.
 * - The key is a canonical issue number — `requireCanonicalIssueKey` has the measurement behind that one.
 *
 * @throws TicketRefError when the path is not GitHub-shaped, or the key is not a canonical issue number.
 */
export function githubTicketRef(repo: string, key: string): GitHubTicketRef {
	if (!isValidRepoPath("github", repo)) {
		throw new TicketRefError(`${repo} is not a GitHub owner and repository`);
	}
	return { tracker: "github", repo: repo.toLowerCase(), key: requireCanonicalIssueKey(key) };
}

/**
 * The GitLab reference for `repo`, `host` and `key`, or a refusal. The path is kept as spelled, for the reason
 * `GitLabTicketRef` gives.
 *
 * @throws TicketRefError when the path is not `namespace/project`, or the key is not a canonical issue number.
 */
export function gitlabTicketRef(repo: string, host: string | null, key: string): GitLabTicketRef {
	if (!isValidRepoPath("gitlab", repo)) {
		throw new TicketRefError(`${repo} is not a GitLab namespace and project`);
	}
	return { tracker: "gitlab", repo, host, key: requireCanonicalIssueKey(key) };
}

/**
 * The Jira reference for `host` and `key`, or a refusal.
 *
 * The key is checked against Jira's own `PROJECT-<number>` shape rather than through
 * `requireCanonicalIssueKey`: Jira addresses an issue by that whole string and does not renumber it, so the
 * padding hazard that rule answers does not arise here.
 *
 * @throws TicketRefError when the key is not a `PROJECT-<number>` form.
 */
export function jiraTicketRef(host: string | null, key: string): JiraTicketRef {
	if (!JIRA_KEY.test(key)) {
		throw new TicketRefError(`${key} is not a valid PROJECT-<number> form`);
	}
	return { tracker: "jira", host, key };
}

/**
 * The issue one reference names, refused unless it is a canonical issue number — leading zeros and a bare `0`
 * as much as non-digits.
 *
 * `gh` normalizes `037` to issue 37 while `compareTicketRefs` treats the two as different tickets, so a padded
 * key would act on one issue under a reference naming another and exit 0. ADR-0032 records the measurement:
 * `gh issue view --repo <repo> -- 022` answered issue 22 on gh 2.100.0. Not measured on `gh issue edit`, which
 * shares the parser — and that inference is exactly why one guard covers both rather than each trusting its own
 * subcommand. `--` does not help: it stops flag parsing, not number normalization.
 *
 * Here rather than at the argv boundary, which is where ADR-0032 first put it: a key is identity, so `ticketId`,
 * the ranking ladder, the worktree path and the session prompt all read it too, and a rule at the argv boundary
 * reaches none of them. ADR-0038 has the full account.
 *
 * @throws TicketRefError when the key is not a canonical issue number.
 */
export function requireCanonicalIssueKey(key: string): string {
	if (!/^[1-9][0-9]*$/.test(key)) {
		throw new TicketRefError(`${key} is not a canonical issue number, so the issue acted on would not be the one it names`);
	}
	return key;
}

const SCHEME_OF: Record<Tracker, string> = { github: "gh", gitlab: "glab", jira: "jira" };

/**
 * The short form of a reference, for display and for a user to paste back as an argument.
 *
 * A known host is deliberately dropped, because no short form carries one: `resolveTicketRef` reads
 * everything before the `#` as the repository path, so a host folded in there parses back as a
 * different repository. Two references differing only in host therefore render alike, which is why
 * this is display and never identity — `ticketId` is identity, and `compareTicketRefs` orders on the
 * whole structure including the host.
 */
export function formatTicketRef(ref: TicketRef): string {
	const scheme = SCHEME_OF[ref.tracker];
	const repo = refRepo(ref);
	return repo === null ? `${scheme}:${ref.key}` : `${scheme}:${repo}#${ref.key}`;
}

/**
 * Orders two references, ascending. This is the ranking ladder's terminal rung, so it must be a total
 * order over distinct references; ADR-0003 says why.
 *
 * Every part of the reference participates, in the order tracker, host, repository, key. Strings are
 * compared by code unit rather than through `localeCompare`, whose result depends on the runtime's
 * locale data and so cannot be pinned by a fixture.
 */
export function compareTicketRefs(a: TicketRef, b: TicketRef): number {
	return (
		compareText(a.tracker, b.tracker) ||
		compareOptional(refHost(a), refHost(b)) ||
		compareOptional(refRepo(a), refRepo(b)) ||
		compareKeys(a.key, b.key)
	);
}

function compareText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

/** A known value sorts after an unknown one, so that the absence itself is a stable position. */
function compareOptional(a: string | null, b: string | null): number {
	if (a === null) return b === null ? 0 : -1;
	if (b === null) return 1;
	return compareText(a, b);
}

/**
 * Compares two keys with their digit runs read as numbers, so ticket 9 precedes ticket 10 and
 * `TEST-9` precedes `TEST-10`. A whole-string comparison breaks the tie that digit runs leave —
 * `07` and `7` are numerically equal and are different tickets.
 */
function compareKeys(a: string, b: string): number {
	const left = keyChunks(a);
	const right = keyChunks(b);
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const one = left[i]!;
		const other = right[i]!;
		const ordered =
			isDigits(one) && isDigits(other) ? compareNumerals(one, other) : compareText(one, other);
		if (ordered !== 0) return ordered;
	}
	return left.length - right.length || compareText(a, b);
}

function keyChunks(key: string): string[] {
	return key.match(/\d+|\D+/g) ?? [];
}

function isDigits(chunk: string): boolean {
	return /^\d+$/.test(chunk);
}

/**
 * Two digit runs as numbers, without converting them to `Number` — a key long enough to exceed the
 * safe integer range would compare equal to its neighbours, and nothing about a ticket key bounds
 * its length.
 */
function compareNumerals(a: string, b: string): number {
	const left = a.replace(/^0+(?=\d)/, "");
	const right = b.replace(/^0+(?=\d)/, "");
	return left.length - right.length || compareText(left, right);
}

/**
 * The GitHub reference a command can act on, or why the reference it was given is not one.
 *
 * Narrowing only: `githubTicketRef` settles the host, the path and the key at construction, so a caller reaching
 * here cannot be holding a reference that fails any of them. ADR-0038 records the collapse.
 *
 * The reason comes back rather than being thrown, because each caller raises its own class: `cli.ts` decides
 * which recovery a failure leaves open from that class, and one shared error would collapse the two.
 */
export type GitHubTicketTarget =
	| { readonly kind: "ticket"; readonly ref: GitHubTicketRef }
	| { readonly kind: "refused"; readonly reason: string };

export function githubTicketTarget(ref: TicketRef): GitHubTicketTarget {
	if (ref.tracker !== "github") {
		return { kind: "refused", reason: `${formatTicketRef(ref)} is not a GitHub ticket, and GitHub is the only tracker this has an adapter for` };
	}
	return { kind: "ticket", ref };
}

export interface ResolveDeps {
	runner?: Runner;
	/**
	 * Which repository the caller is standing in, for the one form that has no repository of its own: a bare
	 * `gh:<number>`. Supplied by a caller that has already resolved it, so a run asks git once rather than once
	 * here and again when the checkout is checked — ADR-0039. Defaults to resolving it from `runner`.
	 */
	checkout?: (refuse: RefuseCheckout) => CheckoutIdentity;
}

const SHORT_FORM = /^(gh|glab|jira):(.+)$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

// Every capture below excludes "?" and "#" so a query string or fragment can never be read as
// part of the host or repository path — without that, a redirect-style URL like
// "https://example.com/?next=/group/project/-/issues/1" would capture "?next=/group/project" as the
// repo, since the URL's actual path is just "/".
//
// A URL authority carrying userinfo (a "user@" prefix before the host) is deliberately not
// parsed out: the whole prefixed string is captured as "host" as-is, which then fails the
// authentication check like any other unrecognised host. Userinfo in a pasted issue URL is
// unsupported, and failing loud this way is sufficient if it ever comes up.
const GITLAB_ISSUE_URL = /^https?:\/\/([^/?#]+)\/([^?#]+?)\/-\/issues\/(\d+)(?:[/?#].*)?$/i;
// Two or more segments before /issues/, and never a "/-/issues/" path (that's GITLAB_ISSUE_URL's
// shape). Exactly two segments is genuinely ambiguous between GitHub and a GitLab instance still
// on the pre-11.0 route with no "/-/" (shape alone can't tell them apart — see whichTracker).
// Three or more can only be GitLab: GitHub has no subgroups, so it never has more than owner/repo.
const GENERIC_ISSUES_URL = /^https?:\/\/([^/?#]+)\/(?!.*\/-\/issues\/)([^/?#]+(?:\/[^/?#]+)+?)\/issues\/(\d+)(?:[/?#].*)?$/i;
// A self-hosted Jira Server/Data Center instance is commonly deployed under a context path
// (e.g. "/jira"), so any prefix before "browse/" is allowed, not just the bare root.
const JIRA_ISSUE_URL = /^https?:\/\/([^/?#]+)\/(?:[^?#]*?\/)?browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i;

export function resolveTicketRef(input: string, deps: ResolveDeps = {}): TicketRef {
	const runner = deps.runner ?? defaultRunner;
	const checkout = deps.checkout ?? ((refuse: RefuseCheckout) => resolveCheckoutIdentity(runner, refuse));
	const trimmed = input.trim();

	const short = SHORT_FORM.exec(trimmed);
	if (short) {
		const scheme = short[1] as "gh" | "glab" | "jira";
		const body = short[2] as string;
		switch (scheme) {
			case "gh":
				return resolveRepoScopedShort("github", "gh", body, runner, checkout);
			case "glab":
				return resolveRepoScopedShort("gitlab", "glab", body, runner, checkout);
			case "jira":
				return jiraTicketRef(null, body);
		}
	}

	if (SCHEME_URL.test(trimmed)) {
		return resolveUrl(trimmed, runner);
	}

	throw new TicketRefError(
		`${input} is not a recognised ticket reference (gh:, glab:, jira: short form, or a pasted issue URL)`,
	);
}


/**
 * A `gh:` or `glab:` short form, in either of its two shapes: a bare number against the checkout's own
 * repository, or an explicit `repo#number`.
 *
 * The bare shape is the one that reaches outside the string it was given, and the two trackers ask different
 * questions of the checkout. GitHub asks for a `CheckoutIdentity`, which exists only where the origin remote is
 * on GitHub. GitLab asks only for the remote's path, because a self-hosted instance can be any host and so its
 * remote carries no comparable evidence; ADR-0039 has why the two readings stay distinct.
 *
 * @throws TicketRefError on either shape the short form does not have, and on anything the reference
 * constructors refuse.
 */
function resolveRepoScopedShort(
	tracker: "github" | "gitlab",
	scheme: "gh" | "glab",
	body: string,
	runner: Runner,
	checkout: (refuse: RefuseCheckout) => CheckoutIdentity,
): TicketRef {
	const hashIndex = body.indexOf("#");
	if (hashIndex === -1) {
		// The shape, before the checkout is consulted, so a mistyped `gh:owner/repo/12` is told what a short form
		// looks like rather than what is wrong with its number. Padding is left to the constructor.
		if (!/^\d+$/.test(body)) {
			throw new TicketRefError(`${scheme}:${body} is not a valid short form (expected a bare number or a repo#number form)`);
		}
		const refuse = (reason: string) => new TicketRefError(`${scheme}:${body} has no explicit repository, and ${reason}`);
		return tracker === "github"
			? githubTicketRef(checkout(refuse).repo, body)
			: gitlabTicketRef(resolveCheckoutRepoPath(runner, refuse), null, body);
	}

	const repo = body.slice(0, hashIndex);
	const key = body.slice(hashIndex + 1);
	return tracker === "github" ? githubTicketRef(repo, key) : gitlabTicketRef(repo, null, key);
}

function resolveUrl(url: string, runner: Runner): TicketRef {
	// GitLab's path contains the literal substring "/issues/" too (inside "/-/issues/").
	// GENERIC_ISSUES_URL's negative lookahead explicitly excludes any path containing
	// "/-/issues/", so the two shapes cannot collide regardless of which is checked first.
	const gitlab = GITLAB_ISSUE_URL.exec(url);
	if (gitlab?.[1] && gitlab[2] && gitlab[3]) {
		const [, rawHost, repo, key] = gitlab;
		const host = normalizeHost(rawHost);
		return authenticatedGitLabRef(repo, host, key, runner);
	}

	const generic = GENERIC_ISSUES_URL.exec(url);
	if (generic?.[1] && generic[2] && generic[3]) {
		const [, rawHost, repo, key] = generic;
		const host = normalizeHost(rawHost);
		// GitHub has no subgroups, so three or more segments can only be GitLab and the host question does not
		// arise. Exactly two is the ambiguous shape `whichTracker` settles.
		if (repo.split("/").length > 2) return authenticatedGitLabRef(repo, host, key, runner);
		return whichTracker(url, host, runner) === "github"
			? githubTicketRef(repo, key)
			// `whichTracker` reached this arm by confirming the authentication, so it is not asked twice.
			: gitlabTicketRef(repo, host, key);
	}

	const jira = JIRA_ISSUE_URL.exec(url);
	if (jira?.[1] && jira[2]) {
		const [, rawHost, key] = jira;
		const host = normalizeHost(rawHost);
		requireJiraAuth(host, runner);
		return jiraTicketRef(host, key);
	}

	throw new TicketRefError(`${url} does not match a GitHub, GitLab, or Jira issue URL shape`);
}

// Hostnames are case-insensitive (URL Standard, host parsing), but the CLIs' own --hostname
// matching and hosts.yml keys are not guaranteed to canonicalize casing themselves — lowercase
// here once, rather than at every downstream comparison.
function normalizeHost(host: string): string {
	return host.toLowerCase();
}

/**
 * Which tracker a two-segment `/<a>/<b>/issues/<n>` URL belongs to, which `GENERIC_ISSUES_URL`'s comment says
 * its shape alone cannot.
 *
 * The host decides, and only the host. GitHub serves its issues from the authorities `isGitHubHost` enumerates
 * and from nowhere else, so a URL on one of them is GitHub's and a URL on any other is not — whatever the `gh`
 * CLI is authenticated to. That is the scope boundary ADR-0038 draws, and it is why this no longer asks `gh`:
 * a GitHub Enterprise host is one `gh` answers for and one this tool cannot act on, so treating that answer as
 * evidence admitted exactly the reference the type now refuses to hold.
 *
 * `glab` is still asked, because a GitLab instance really can be any host and nothing else distinguishes one.
 *
 * @throws TicketRefError when the host is neither GitHub's nor one `glab` is authenticated to. The message names
 * the scope boundary rather than reporting an unrecognized URL, because the URL was recognized: what it names is
 * out of scope, and those are different things to be told.
 */
function whichTracker(url: string, host: string, runner: Runner): "github" | "gitlab" {
	if (isGitHubHost(host)) return "github";
	if (isAuthenticatedHost("gitlab", host, runner)) return "gitlab";
	throw new TicketRefError(
		`${url} is an issue on ${host}, and this works on ${GITHUB_HOST} only — a GitHub Enterprise instance is out of scope, and ${host} does not match any host the glab CLI is authenticated to either`,
	);
}

/**
 * A GitLab reference from a URL whose shape already says it is GitLab's, once the host is one `glab` can reach.
 *
 * Built before the authentication is asked about, so that a malformed path or key is reported as the malformed
 * thing it is rather than as an unreachable host. That was the path check's order before it moved into the
 * constructor; the key check is new here, and takes the same position.
 *
 * @throws TicketRefError from the constructor, and when `glab` is authenticated to no such host.
 */
function authenticatedGitLabRef(repo: string, host: string, key: string, runner: Runner): GitLabTicketRef {
	const ref = gitlabTicketRef(repo, host, key);
	if (!isAuthenticatedHost("gitlab", host, runner)) {
		throw new TicketRefError(`${host} does not match any host the glab CLI is authenticated to`);
	}
	return ref;
}

function requireJiraAuth(host: string, runner: Runner): void {
	if (!hasJiraAuth(runner)) {
		throw new TicketRefError(`no authenticated Jira session found to resolve ${host}`);
	}
}
