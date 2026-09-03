import { type Exec, defaultExec } from "./exec";
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
	exec?: Exec;
}

const SHORT_FORM = /^(gh|glab|jira|md):(.+)$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const MARKDOWN_KEY = /^\d+$/;

const GITLAB_ISSUE_URL = /^https?:\/\/([^/]+)\/(.+)\/-\/issues\/(\d+)(?:[/?#].*)?$/;
const GITHUB_ISSUE_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#].*)?$/;
const JIRA_ISSUE_URL = /^https?:\/\/([^/]+)\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/;

export function resolveTicketRef(input: string, deps: ResolveDeps = {}): TicketRef {
	const exec = deps.exec ?? defaultExec;
	const trimmed = input.trim();

	const short = SHORT_FORM.exec(trimmed);
	if (short) {
		const scheme = short[1] as "gh" | "glab" | "jira" | "md";
		const body = short[2] as string;
		switch (scheme) {
			case "gh":
				return resolveRepoScopedShort("github", "gh", body, exec);
			case "glab":
				return resolveRepoScopedShort("gitlab", "glab", body, exec);
			case "jira":
				return resolveJiraShort(body);
			case "md":
				return resolveMarkdownShort(body);
		}
	}

	if (SCHEME_URL.test(trimmed)) {
		return resolveUrl(trimmed, exec);
	}

	throw new TicketRefError(
		`${input} is not a recognised ticket reference (gh:, glab:, jira:, md: short form, or a pasted issue URL)`,
	);
}

function resolveRepoScopedShort(
	tracker: "github" | "gitlab",
	scheme: "gh" | "glab",
	body: string,
	exec: Exec,
): TicketRef {
	const hashIndex = body.indexOf("#");
	if (hashIndex === -1) {
		if (!/^\d+$/.test(body)) {
			throw new TicketRefError(`${scheme}:${body} is neither an issue number nor a repo#number form`);
		}
		const repo = resolveRepoFromOrigin(exec);
		if (!repo) {
			throw new TicketRefError(
				`${scheme}:${body} has no explicit repository, and the working directory's git remote could not be resolved`,
			);
		}
		return { tracker, repo, host: null, key: body };
	}

	const repo = body.slice(0, hashIndex);
	const key = body.slice(hashIndex + 1);
	if (!repo || !/^\d+$/.test(key)) {
		throw new TicketRefError(`${scheme}:${body} is not a valid repo#number form`);
	}
	return { tracker, repo, host: null, key };
}

function resolveJiraShort(body: string): TicketRef {
	if (!JIRA_KEY.test(body)) {
		throw new TicketRefError(`jira:${body} is not a valid PROJECT-number key`);
	}
	return { tracker: "jira", repo: null, host: null, key: body };
}

function resolveMarkdownShort(body: string): TicketRef {
	if (!MARKDOWN_KEY.test(body)) {
		throw new TicketRefError(`md:${body} is not a valid ticket number`);
	}
	return { tracker: "markdown", repo: null, host: null, key: body };
}

function resolveUrl(url: string, exec: Exec): TicketRef {
	// GitLab's `/-/issues/` is checked first because it is a superset of GitHub's `/issues/`
	// shape — a GitLab URL would otherwise misparse as GitHub with a mangled repo path.
	const gitlab = GITLAB_ISSUE_URL.exec(url);
	if (gitlab?.[1] && gitlab[2] && gitlab[3]) {
		const [, host, repo, key] = gitlab;
		requireAuthenticatedHost("gitlab", host, exec);
		return { tracker: "gitlab", repo, host, key };
	}

	const github = GITHUB_ISSUE_URL.exec(url);
	if (github?.[1] && github[2] && github[3]) {
		const [, host, repo, key] = github;
		requireAuthenticatedHost("github", host, exec);
		return { tracker: "github", repo, host, key };
	}

	const jira = JIRA_ISSUE_URL.exec(url);
	if (jira?.[1] && jira[2]) {
		const [, host, key] = jira;
		requireJiraAuth(host, exec);
		return { tracker: "jira", repo: null, host, key };
	}

	throw new TicketRefError(`${url} does not match a GitHub, GitLab, or Jira issue URL shape`);
}

function requireAuthenticatedHost(tracker: "github" | "gitlab", host: string, exec: Exec): void {
	if (!isAuthenticatedHost(tracker, host, exec)) {
		const cli = tracker === "github" ? "gh" : "glab";
		throw new TicketRefError(`${host} does not match any host the ${cli} CLI is authenticated to`);
	}
}

function requireJiraAuth(host: string, exec: Exec): void {
	if (!hasJiraAuth(exec)) {
		throw new TicketRefError(`no authenticated Jira session found to resolve ${host}`);
	}
}
