import { type TicketRef, formatTicketRef, requireCanonicalIssueKey } from "./ticket-ref";

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

/**
 * Whether the binary a session is started with is there and will run.
 *
 * Asked because a binary that is missing or broken is the likeliest reason a session never starts, and the one
 * that can be settled before anything is written — ADR-0036, which also has why nothing checks afterwards.
 *
 * `--version` rather than a `command -v`, because the runner spawns argv with no shell, and because running the
 * binary is a stronger answer than finding a file with the right name.
 */
export function sessionBinaryAliveCommand(): Argv {
	return [SESSION_BINARY, "--version"];
}

export interface SessionCommandInput {
	readonly ref: TicketRef;
	readonly slashCommand: string;
}

/**
 * Whether a word is a slash command: `/` and one word. Exported because the command line has to refuse a bad
 * `--slash-command` value as a usage error, and this is the shape that decides it — two copies of the pattern
 * would let a value pass the flag's own check and then throw from `sessionCommand` with a stack instead.
 */
export function isSlashCommand(word: string): boolean {
	return /^\/\S+$/.test(word);
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
export function sessionCommand(input: SessionCommandInput): Argv {
	if (!isSlashCommand(input.slashCommand)) {
		throw new CommandBuilderError(`${input.slashCommand} is not a slash command: it must be "/" and one word`);
	}
	return [SESSION_BINARY, `${input.slashCommand} ${formatTicketRef(input.ref)}`];
}

/**
 * The workspace host a session is started in.
 *
 * Not a parameter, for the reason `SESSION_BINARY` is not.
 */
export const WORKSPACE_HOST = "cmux";

/** Whether the workspace host is there to be asked for a workspace at all. */
export function workspaceHostAliveCommand(): Argv {
	return [WORKSPACE_HOST, "ping"];
}

export interface WorkspaceCommandInput {
	/** What the workspace is called in the host's own listing. */
	readonly name: string;
	/** The worktree the session runs in. */
	readonly cwd: string;
	readonly command: Argv;
}

/**
 * The workspace that runs one session in one worktree.
 *
 * The host types `--command` into the workspace's shell rather than executing it as argv, and offers no
 * argv form — `--layout` spells its surfaces' commands as text too — so the session argv is rendered by
 * `formatCommand` and a shell parses it back. That is the one caller for which a formatted line is
 * executed rather than read, which `formatCommand` says what it costs.
 *
 * `--focus true` because the host defaults it to false: a run asked to start work would otherwise report
 * having started it with nothing on screen.
 */
export function workspaceCommand(input: WorkspaceCommandInput): Argv {
	return [
		WORKSPACE_HOST,
		"new-workspace",
		"--name",
		input.name,
		"--cwd",
		input.cwd,
		"--command",
		formatCommand(input.command),
		"--focus",
		"true",
	];
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
 * Whether one fully-qualified ref is there. Answered by `show-ref` rather than by scanning the worktree
 * listing, which sees only branches that are checked out somewhere.
 *
 * Takes the whole ref rather than a branch name, because two callers need different namespaces: a local
 * branch under `refs/heads/`, and the target `origin/HEAD` points at, which `symbolic-ref` will report
 * happily even when the ref itself does not exist.
 */
export function refExistsCommand(repo: string, ref: string): readonly string[] {
	return ["git", "-C", repo, "show-ref", "--verify", "--quiet", ref];
}

/**
 * Every remote-tracking ref for this branch, asked when the repository has no branch of its own. A branch
 * that exists only on a remote must not be created: `git worktree add` without `-b` checks out the remote
 * tip and sets up tracking, while `-b` cuts a new branch from local HEAD and silently leaves the pushed
 * work behind.
 *
 * The whole list rather than `show-ref` on `origin` alone, because the count is the other half of the
 * answer. `git worktree add <path> <branch>` resolves a remote-only branch by guessing, and it refuses to
 * guess when more than one remote offers the name — `fatal: invalid reference` rather than a worktree.
 * Asking this way costs no extra command and tells us both whether `origin` has it and whether anything
 * else does.
 */
export function remoteBranchesCommand(repo: string, branch: string): readonly string[] {
	return ["git", "-C", repo, "for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`];
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
 * What a directory *is*, asked of git from inside it: its own worktree root, then the ref checked out there.
 *
 * Asked of git rather than read off `git worktree list`, because the listing is the thing that can be
 * wrong: a worktree whose `.git` file has been edited is still listed under the branch it was registered
 * with, while git run inside it answers about somewhere else.
 *
 * `--symbolic-full-name` rather than `--abbrev-ref`, because abbreviation is not stable: it disambiguates
 * against other refs, so a tag sharing the branch's name turns `feature/x` into `heads/feature/x` and a
 * comparison against the branch name stops matching a worktree that is perfectly valid.
 *
 * The ref comes last on purpose. A path may contain a newline — `parseWorktreeList` supports that
 * deliberately — while a ref cannot, so a caller can take the final line as the ref and everything before it
 * as the path. Asking for two paths in one call would have no such delimiter.
 */
export function worktreeIdentityCommand(path: string): readonly string[] {
	return ["git", "-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--symbolic-full-name", "HEAD"];
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
 * The projection the GitHub read adapter parses. Fixed rather than a parameter, so that what a read asks for
 * cannot drift per caller — a capture that needs a narrower projection builds it from this.
 *
 * `blockedBy` is the native dependency surface, and the only blocking channel — `issue_dependencies_summary`
 * lags under write in both directions, which `docs/agents/issue-tracker.md` measures.
 */
export const GITHUB_TICKET_FIELDS: readonly string[] = [
	"number",
	"title",
	"state",
	"assignees",
	"labels",
	"url",
	"blockedBy",
];

export interface GitHubIssueListInput {
	readonly repo: string;
	readonly rows: number;
}

/**
 * The states one read asks for, exported so that an adapter reports what was asked rather than restating it:
 * `TicketSetRead.openOnly` is derived from this, so changing it here changes what the counts may claim.
 *
 * Declared as the pair rather than inferred as the one value it holds, so that deriving a boolean from it
 * stays a comparison. Inferred, `GITHUB_TICKET_STATE === "open"` has no overlap to compare and changing this
 * line fails the build in `github-adapter.ts` instead of flipping the flag it advertises.
 */
export const GITHUB_TICKET_STATE: "open" | "all" = "open";

/**
 * One read of a GitHub ticket set. `--state open` rather than every state: a closed blocker's own state
 * arrives on its dependent's edge, so nothing needs it as a row. ADR-0028 has why that is worth the row
 * limit it buys back, and what the counts may claim in exchange.
 *
 * @throws CommandBuilderError when `rows` is not a positive whole number.
 */
export function githubIssueListCommand(input: GitHubIssueListInput): readonly string[] {
	if (!Number.isSafeInteger(input.rows) || input.rows < 1) {
		throw new CommandBuilderError(`${input.rows} is not a number of rows to ask for: it must be a whole number above zero`);
	}
	return [
		"gh",
		"issue",
		"list",
		"--repo",
		input.repo,
		"--state",
		GITHUB_TICKET_STATE,
		"--limit",
		String(input.rows),
		"--json",
		GITHUB_TICKET_FIELDS.join(","),
	];
}

/**
 * An issue-list argv with the blocking field taken out of its projection, so the response carries no `blockedBy`
 * key at all. `capture:github` stores that shape under `ticket-set-without-blockers` and says what it is for.
 *
 * Not a parameter of `githubIssueListCommand`, which stays the one projection every read asks for. This is the
 * narrowing two callers outside the read need: the capture that stores the shape, and the live check that asserts
 * an absent field reads as unknown.
 *
 * @throws CommandBuilderError when the argv does not spell its projection as one word, since returning it
 * unchanged would hand back a read of the opposite shape under this name.
 */
export function withoutBlockingField(argv: readonly string[]): readonly string[] {
	const projection = GITHUB_TICKET_FIELDS.join(",");
	const kept = GITHUB_TICKET_FIELDS.filter((field) => field !== "blockedBy").join(",");
	if (!argv.includes(projection)) {
		throw new CommandBuilderError(`${formatCommand(argv)} does not spell the issue-list projection as one word`);
	}
	return argv.map((word) => (word === projection ? kept : word));
}

export interface GitHubIssueCommandInput {
	readonly repo: string;
	readonly key: string;
}

/**
 * One read of a single named GitHub ticket, for the override path — ADR-0037 has why a named ticket is read by
 * its own call rather than looked up inside a set read.
 *
 * The projection is `GITHUB_TICKET_FIELDS`, so the row this answers with is the shape the set read's own row
 * reader parses. No state filter, unlike the list read: a closed ticket has to come back as closed, because
 * "closed" is the refusal an operator who named it needs to be told.
 *
 * @throws TicketRefError from the canonical-key assertion, which a `GitHubTicketRef` cannot trip. ADR-0038 has
 * why it stays here anyway: this builder takes a bare `repo` and `key`, so a caller reaching past the reference
 * types can still spell one, and the capture script does.
 */
export function githubIssueViewCommand(input: GitHubIssueCommandInput): readonly string[] {
	return ["gh", "issue", "view", "--repo", input.repo, "--json", GITHUB_TICKET_FIELDS.join(","), "--", requireCanonicalIssueKey(input.key)];
}

export type GitHubClaimCommandInput = GitHubIssueCommandInput;

/**
 * The one write that claims a GitHub ticket.
 *
 * `@me` rather than a login looked up first, so the identity is resolved by the same call that writes.
 * ADR-0018 requires the claim be a single call, and a separate `gh api user` would be a second one whose
 * answer nothing here is allowed to compare against.
 *
 * The key goes last, after `--`, so that no spelling of it can be read as a flag rather than as the issue.
 *
 * @throws TicketRefError from the canonical-key assertion, for the reason `githubIssueViewCommand` gives.
 * ADR-0032 has why a write refuses a padded key rather than sending it and reading the exit status.
 */
export function githubClaimCommand(input: GitHubClaimCommandInput): readonly string[] {
	return ["gh", "issue", "edit", "--repo", input.repo, "--add-assignee", "@me", "--", requireCanonicalIssueKey(input.key)];
}

/**
 * Argv as one line a POSIX shell parses back into the same words, for a human to read or paste, and for
 * `workspaceCommand`, whose host accepts no argv.
 *
 * That second caller is why the quoting below is load-bearing rather than cosmetic: a line this builds is
 * executed, not only read, so a word it fails to quote reaches a shell as syntax. The runner still takes
 * argv everywhere else, so this is the only such path and it is one call wide.
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
