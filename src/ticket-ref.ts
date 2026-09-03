import { type Runner, defaultRunner } from "./runner";
import { resolveRepoFromOrigin } from "./git-remote";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";

export type Tracker = "github" | "gitlab" | "jira" | "markdown";

export interface TicketRef {
	tracker: Tracker;
	/** `owner/repo` (github) or `namespace/project` (gitlab); null for jira and markdown. */
	repo: string | null;
	/** The tracker host, known only when parsed from a pasted URL. */
	host: string | null;
	key: string;
}

export class TicketRefError extends Error {}

export interface ResolveDeps {
	runner?: Runner;
}

const SHORT_FORM = /^(gh|glab|jira|md):(.+)$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const MARKDOWN_KEY = /^\d+$/;

const GITLAB_ISSUE_URL = /^https?:\/\/([^/]+)\/(.+?)\/-\/issues\/(\d+)(?:[/?#].*)?$/i;
// Two or more segments before /issues/, and never a "/-/issues/" path (that's GITLAB_ISSUE_URL's
// shape). Exactly two segments is genuinely ambiguous between GitHub and a GitLab instance still
// on the pre-11.0 route with no "/-/" (shape alone can't tell them apart — see disambiguateHost).
// Three or more can only be GitLab: GitHub has no subgroups, so it never has more than owner/repo.
const GENERIC_ISSUES_URL = /^https?:\/\/([^/]+)\/(?!.*\/-\/issues\/)([^/]+(?:\/[^/]+)+?)\/issues\/(\d+)(?:[/?#].*)?$/i;
const JIRA_ISSUE_URL = /^https?:\/\/([^/]+)\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i;

export function resolveTicketRef(input: string, deps: ResolveDeps = {}): TicketRef {
	const runner = deps.runner ?? defaultRunner;
	const trimmed = input.trim();

	const short = SHORT_FORM.exec(trimmed);
	if (short) {
		const scheme = short[1] as "gh" | "glab" | "jira" | "md";
		const body = short[2] as string;
		switch (scheme) {
			case "gh":
				return resolveRepoScopedShort("github", "gh", body, runner);
			case "glab":
				return resolveRepoScopedShort("gitlab", "glab", body, runner);
			case "jira":
				return resolveJiraShort(body);
			case "md":
				return resolveMarkdownShort(body);
		}
	}

	if (SCHEME_URL.test(trimmed)) {
		return resolveUrl(trimmed, runner);
	}

	throw new TicketRefError(
		`${input} is not a recognised ticket reference (gh:, glab:, jira:, md: short form, or a pasted issue URL)`,
	);
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
		const repo = resolveRepoFromOrigin(runner);
		if (!repo) {
			throw new TicketRefError(
				`${scheme}:${body} has no explicit repository, and the working directory's git remote could not be resolved`,
			);
		}
		return { tracker, repo, host: null, key: body };
	}

	const repo = body.slice(0, hashIndex);
	const key = body.slice(hashIndex + 1);
	if (!repo.includes("/") || !/^\d+$/.test(key)) {
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

function resolveMarkdownShort(body: string): TicketRef {
	if (!MARKDOWN_KEY.test(body)) {
		throw new TicketRefError(`md:${body} is not a valid ticket number`);
	}
	return { tracker: "markdown", repo: null, host: null, key: body };
}

function resolveUrl(url: string, runner: Runner): TicketRef {
	// GitLab's path contains the literal substring "/issues/" too (inside "/-/issues/").
	// GENERIC_ISSUES_URL's negative lookahead explicitly excludes any path containing
	// "/-/issues/", so the two shapes cannot collide regardless of which is checked first.
	const gitlab = GITLAB_ISSUE_URL.exec(url);
	if (gitlab?.[1] && gitlab[2] && gitlab[3]) {
		const [, host, repo, key] = gitlab;
		requireAuthenticatedHost("gitlab", host, runner);
		return { tracker: "gitlab", repo, host, key };
	}

	const generic = GENERIC_ISSUES_URL.exec(url);
	if (generic?.[1] && generic[2] && generic[3]) {
		const [, host, repo, key] = generic;
		if (repo.split("/").length > 2) {
			requireAuthenticatedHost("gitlab", host, runner);
			return { tracker: "gitlab", repo, host, key };
		}
		const tracker = disambiguateHost(host, runner);
		return { tracker, repo, host, key };
	}

	const jira = JIRA_ISSUE_URL.exec(url);
	if (jira?.[1] && jira[2]) {
		const [, host, key] = jira;
		requireJiraAuth(host, runner);
		return { tracker: "jira", repo: null, host, key };
	}

	throw new TicketRefError(`${url} does not match a GitHub, GitLab, or Jira issue URL shape`);
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
