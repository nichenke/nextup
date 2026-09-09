import { type Runner, defaultRunner } from "./runner";
import { resolveOriginRemote } from "./git-remote";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";

export type Tracker = "github" | "gitlab" | "jira";

/**
 * GitHub's own host. Lives here rather than in the adapter because a short form resolved from a git remote has
 * to check it before any adapter is reached, and the adapter importing from here keeps that one-way.
 */
export const GITHUB_HOST = "github.com";

/**
 * Whether a git remote's host is GitHub's. The port is dropped before comparing, and GitHub's `ssh.` endpoint is
 * accepted beside the web host: an SSH remote naming port 22 explicitly, and GitHub's published port-443
 * workaround for a firewalled 22, are both ordinary remotes that comparing the authority whole refused.
 */
export function isGitHubHost(host: string): boolean {
	const bare = host.replace(/:\d+$/, "");
	return bare === GITHUB_HOST || bare === `ssh.${GITHUB_HOST}`;
}

export interface TicketRef {
	tracker: Tracker;
	/** `owner/repo` (github) or `namespace/project` (gitlab); null for jira. */
	repo: string | null;
	/** The tracker host, known only when parsed from a pasted URL. */
	host: string | null;
	key: string;
}

export class TicketRefError extends Error {}

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
	return ref.repo === null ? `${scheme}:${ref.key}` : `${scheme}:${ref.repo}#${ref.key}`;
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
		compareOptional(a.host, b.host) ||
		compareOptional(a.repo, b.repo) ||
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

export interface ResolveDeps {
	runner?: Runner;
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
// on the pre-11.0 route with no "/-/" (shape alone can't tell them apart — see disambiguateHost).
// Three or more can only be GitLab: GitHub has no subgroups, so it never has more than owner/repo.
const GENERIC_ISSUES_URL = /^https?:\/\/([^/?#]+)\/(?!.*\/-\/issues\/)([^/?#]+(?:\/[^/?#]+)+?)\/issues\/(\d+)(?:[/?#].*)?$/i;
// A self-hosted Jira Server/Data Center instance is commonly deployed under a context path
// (e.g. "/jira"), so any prefix before "browse/" is allowed, not just the bare root.
const JIRA_ISSUE_URL = /^https?:\/\/([^/?#]+)\/(?:[^?#]*?\/)?browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i;

export function resolveTicketRef(input: string, deps: ResolveDeps = {}): TicketRef {
	const runner = deps.runner ?? defaultRunner;
	const trimmed = input.trim();

	const short = SHORT_FORM.exec(trimmed);
	if (short) {
		const scheme = short[1] as "gh" | "glab" | "jira";
		const body = short[2] as string;
		switch (scheme) {
			case "gh":
				return resolveRepoScopedShort("github", "gh", body, runner);
			case "glab":
				return resolveRepoScopedShort("gitlab", "glab", body, runner);
			case "jira":
				return resolveJiraShort(body);
		}
	}

	if (SCHEME_URL.test(trimmed)) {
		return resolveUrl(trimmed, runner);
	}

	throw new TicketRefError(
		`${input} is not a recognised ticket reference (gh:, glab:, jira: short form, or a pasted issue URL)`,
	);
}

// GitHub is always exactly owner/repo; GitLab allows a nested namespace/subgroup, so two or
// more. Either way every segment must be non-empty, rejecting shapes like "/repo", "owner/",
// or "group//repo" that `repo.includes("/")` alone would have let through.
export function isValidRepoPath(tracker: "github" | "gitlab", repo: string): boolean {
	const segments = repo.split("/");
	if (segments.some((segment) => segment === "")) return false;
	return tracker === "github" ? segments.length === 2 : segments.length >= 2;
}

function resolveRepoScopedShort(
	tracker: "github" | "gitlab",
	scheme: "gh" | "glab",
	body: string,
	runner: Runner,
): TicketRef {
	const hashIndex = body.indexOf("#");
	if (hashIndex === -1) {
		if (!/^\d+$/.test(body)) {
			throw new TicketRefError(`${scheme}:${body} is not a valid short form (expected a bare number or a repo#number form)`);
		}
		const origin = resolveOriginRemote(runner);
		if (!origin || !isValidRepoPath(tracker, origin.repo)) {
			throw new TicketRefError(
				`${scheme}:${body} has no explicit repository, and the working directory's git remote could not be resolved`,
			);
		}
		// A short form carries no host, so the remote's is the only evidence of which system it names — and a
		// resolved `owner/repo` is indistinguishable from the same path on any other host. Without this, `gh:1` in
		// a GitHub Enterprise or GitLab checkout resolves to whatever sits at that path on github.com, and every
		// reader downstream operates on a repository the user never named. GitLab is not checked the same way
		// because a self-hosted instance can be any host, so its remote carries no comparable evidence.
		if (tracker === "github" && !isGitHubHost(origin.host)) {
			throw new TicketRefError(
				`${scheme}:${body} resolves through a remote on ${origin.host}, which is not ${GITHUB_HOST} — name the repository explicitly if that is what you meant`,
			);
		}
		return { tracker, repo: origin.repo, host: null, key: body };
	}

	const repo = body.slice(0, hashIndex);
	const key = body.slice(hashIndex + 1);
	if (!isValidRepoPath(tracker, repo) || !/^\d+$/.test(key)) {
		throw new TicketRefError(`${scheme}:${body} is not a valid repo#number form`);
	}
	return { tracker, repo, host: null, key };
}

function resolveJiraShort(body: string): TicketRef {
	if (!JIRA_KEY.test(body)) {
		throw new TicketRefError(`jira:${body} is not a valid PROJECT-<number> form`);
	}
	return { tracker: "jira", repo: null, host: null, key: body };
}

function resolveUrl(url: string, runner: Runner): TicketRef {
	// GitLab's path contains the literal substring "/issues/" too (inside "/-/issues/").
	// GENERIC_ISSUES_URL's negative lookahead explicitly excludes any path containing
	// "/-/issues/", so the two shapes cannot collide regardless of which is checked first.
	const gitlab = GITLAB_ISSUE_URL.exec(url);
	if (gitlab?.[1] && gitlab[2] && gitlab[3]) {
		const [, rawHost, repo, key] = gitlab;
		const host = normalizeHost(rawHost);
		if (!isValidRepoPath("gitlab", repo)) {
			throw new TicketRefError(`${url} does not have a valid namespace/project path`);
		}
		requireAuthenticatedHost("gitlab", host, runner);
		return { tracker: "gitlab", repo, host, key };
	}

	const generic = GENERIC_ISSUES_URL.exec(url);
	if (generic?.[1] && generic[2] && generic[3]) {
		const [, rawHost, repo, key] = generic;
		const host = normalizeHost(rawHost);
		if (repo.split("/").length > 2) {
			requireAuthenticatedHost("gitlab", host, runner);
			return { tracker: "gitlab", repo, host, key };
		}
		const tracker = disambiguateHost(host, runner);
		return { tracker, repo, host, key };
	}

	const jira = JIRA_ISSUE_URL.exec(url);
	if (jira?.[1] && jira[2]) {
		const [, rawHost, key] = jira;
		const host = normalizeHost(rawHost);
		requireJiraAuth(host, runner);
		return { tracker: "jira", repo: null, host, key };
	}

	throw new TicketRefError(`${url} does not match a GitHub, GitLab, or Jira issue URL shape`);
}

// Hostnames are case-insensitive (URL Standard, host parsing), but the CLIs' own --hostname
// matching and hosts.yml keys are not guaranteed to canonicalize casing themselves — lowercase
// here once, rather than at every downstream comparison.
function normalizeHost(host: string): string {
	return host.toLowerCase();
}

function disambiguateHost(host: string, runner: Runner): "github" | "gitlab" {
	const githubAuthed = isAuthenticatedHost("github", host, runner);
	const gitlabAuthed = isAuthenticatedHost("gitlab", host, runner);
	if (githubAuthed && gitlabAuthed) {
		throw new TicketRefError(
			`${host} is authenticated to both the gh and glab CLIs, and the URL shape does not say which tracker it belongs to`,
		);
	}
	if (githubAuthed) return "github";
	if (gitlabAuthed) return "gitlab";
	throw new TicketRefError(`${host} does not match any host the gh or glab CLI is authenticated to`);
}

function requireAuthenticatedHost(tracker: "github" | "gitlab", host: string, runner: Runner): void {
	if (!isAuthenticatedHost(tracker, host, runner)) {
		const cli = tracker === "github" ? "gh" : "glab";
		throw new TicketRefError(`${host} does not match any host the ${cli} CLI is authenticated to`);
	}
}

function requireJiraAuth(host: string, runner: Runner): void {
	if (!hasJiraAuth(runner)) {
		throw new TicketRefError(`no authenticated Jira session found to resolve ${host}`);
	}
}
