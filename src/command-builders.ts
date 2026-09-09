import { type TicketRef, formatTicketRef } from "./ticket-ref";

export class CommandBuilderError extends Error {}

/**
 * Argv carrying at least the program, so a value of this type cannot be a command with nothing to run.
 */
export type Argv = readonly [string, ...string[]];

/** The verb the launched session runs when nothing names another; ticket 09 exposes the choice. */
export const DEFAULT_SLASH_COMMAND = "/implement";

/**
 * The binary a session is started with. Not a parameter: which harness runs the work is a property of
 * this tool rather than of a ticket, and a flag for it would be a second way to say what the launcher
 * already is.
 */
const SESSION_BINARY = "claude";

export interface SessionCommandInput {
	readonly ref: TicketRef;
	readonly slashCommand: string;
}

/**
 * The argv that starts a session working on one ticket.
 *
 * The whole task is the reference, per the spec's Launching section: a briefing would carry the
 * selector's own reasoning into the new session and bias it toward whichever framing won the ranking,
 * so the session reads the ticket itself. Prompt and reference are one argument, because two would
 * reach the session as a slash command with no argument followed by a stray word.
 *
 * @throws CommandBuilderError when `slashCommand` is not a single `/`-prefixed word.
 */
export function sessionCommand(input: SessionCommandInput): readonly string[] {
	if (!/^\/\S+$/.test(input.slashCommand)) {
		throw new CommandBuilderError(`${input.slashCommand} is not a slash command: it must be "/" and one word`);
	}
	return [SESSION_BINARY, `${input.slashCommand} ${formatTicketRef(input.ref)}`];
}

/** The tracker CLIs this tool asks about a host, and the flag each spells the host with. */
const AUTH_STATUS: Record<"github" | "gitlab", readonly string[]> = {
	github: ["gh", "auth", "status", "--hostname"],
	// `gh` alone takes `--active`: it exits 1 when *any* account on a host has a problem, including an
	// inactive one, so the check has to be narrowed to the account that would be used. `glab` has no
	// multi-account concept to narrow.
	gitlab: ["glab", "auth", "status", "--hostname"],
};

/** Whether a tracker CLI reports itself authenticated to one host. */
export function authStatusCommand(tracker: "github" | "gitlab", hostname: string): readonly string[] {
	const base = [...AUTH_STATUS[tracker], hostname];
	return tracker === "github" ? [...base, "--active"] : base;
}

/**
 * Whether the Jira CLI has a session at all. Jira's config stores an API-gateway host rather than the
 * browse host a pasted link shows, so there is no host to ask about and presence is the whole signal.
 */
export function jiraIdentityCommand(): readonly string[] {
	return ["jira", "me"];
}

/** The remote a repository-scoped reference is resolved against. */
export function originRemoteCommand(): readonly string[] {
	return ["git", "remote", "get-url", "origin"];
}

export function worktreeListCommand(repo: string): readonly string[] {
	// `-z`, for the reason `parseWorktreeList` gives.
	return ["git", "-C", repo, "worktree", "list", "--porcelain", "-z"];
}

/**
 * Whether the repository already has this branch. Answered by `show-ref` rather than by scanning the
 * worktree listing, which sees only branches that are checked out somewhere.
 */
export function branchExistsCommand(repo: string, branch: string): readonly string[] {
	return ["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
}

/**
 * Whether `origin` has this branch, asked when the repository does not. A branch that exists only on the
 * remote must not be created: `git worktree add` without `-b` checks out the remote tip and sets up
 * tracking, while `-b` cuts a new branch from local HEAD and silently leaves the pushed work behind.
 */
export function remoteBranchExistsCommand(repo: string, branch: string): readonly string[] {
	return ["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`];
}

/**
 * Where the repository keeps its administration, absolutely, and shared across every worktree.
 *
 * Asked so that a repository whose git directory is not `<checkout>/.git` can be refused rather than
 * worked in. `--path-format=absolute` because the default is relative to the current directory, which is
 * not the directory being asked about; `--git-common-dir` rather than `--git-dir` because a linked
 * worktree's own `--git-dir` is its private subdirectory, and the shared one is what identifies the
 * repository.
 */
export function gitCommonDirCommand(repo: string): readonly string[] {
	return ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"];
}

/**
 * Which branch the repository treats as its default.
 *
 * The full ref, because `--short` shortens only as far as stays unambiguous: with a local branch named
 * `origin/main` in the repository it answers `remotes/origin/main` rather than `origin/main`, and a
 * caller stripping `origin/` is then left comparing `remotes/origin/main` against a branch name.
 *
 * The answer is not always under `refs/remotes/origin/`, so a caller must check the prefix rather than
 * slice a fixed width off it. git accepts `symbolic-ref refs/remotes/origin/HEAD refs/heads/main`, and
 * also a pointer to a branch that does not exist. `driftWarnings` in `worktree.ts` is where that is
 * checked.
 */
export function defaultBranchCommand(repo: string): readonly string[] {
	return ["git", "-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD"];
}

/**
 * The worktree for one branch, at one path. `create` picks between cutting a new branch from `repo`'s
 * HEAD and checking out one that already exists; `-b` against an existing branch is a fatal error
 * rather than an attach, so the two cannot share an invocation.
 */
export function worktreeAddCommand(repo: string, path: string, branch: string, create: boolean): Argv {
	const add = ["git", "-C", repo, "worktree", "add", path] as const;
	return create ? [...add, "-b", branch] : [...add, branch];
}

/**
 * Argv as one line a POSIX shell parses back into the same words, for a human to read or paste. It is
 * never what the tool executes — the runner takes argv — so this cannot become the path by which a
 * quoting bug reaches a shell.
 */
export function formatCommand(argv: readonly string[]): string {
	return argv.map((word, index) => quote(word, index === 0)).join(" ");
}

// Single quotes, which a POSIX shell leaves entirely literal, so only the closing quote itself needs
// handling. Deciding a word is safe by an allowlist rather than by escaping the characters that are
// not: an escape list has to stay complete as shells add syntax, and an allowlist that falls behind
// only over-quotes.
function quote(word: string, first: boolean): string {
	// `=` is safe in every word but the first, where a shell reads `name=value` as an assignment and
	// runs whatever follows instead.
	const safe = /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) && !(first && word.includes("="));
	if (word !== "" && safe) return word;
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
