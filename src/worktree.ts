import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { branchExistsCommand, defaultBranchCommand, worktreeAddCommand, worktreeListCommand } from "./command-builders";
import type { Runner } from "./runner";
import type { Ticket } from "./ticket";

/**
 * Why a worktree could not be brought into the required state. The two refusals are the ones the spec
 * names; `"git"` is a command that failed for a reason this tool did not anticipate, kept separate so
 * that a broken repository does not read as one of the two states this knows how to describe.
 *
 * `"stale-directory"` covers everything occupying the expected path that is not the worktree wanted
 * there — leftover files, a registration whose directory has gone, a worktree on another branch. One
 * kind rather than three because the remedy is the same in each case, a person looking at that path;
 * the message says which of them it is.
 */
export class WorktreeError extends Error {
	readonly kind: "stale-directory" | "branch-elsewhere" | "git";

	constructor(message: string, kind: WorktreeError["kind"]) {
		super(message);
		this.kind = kind;
	}
}

/**
 * Where worktrees go when nothing else says. Relative, and resolved against the primary checkout, so
 * that a run started from inside one worktree does not nest the next one underneath it.
 *
 * `.worktrees/` rather than the harness's `.claude/worktrees/`. ADR-0005 reproduced the reason: the
 * harness's session-exit cleanup keys on an in-session flag its own `EnterWorktree` sets, not on a
 * path, so a worktree created by `git worktree add` gets no cleanup at either location and the
 * harness's path buys nothing.
 */
export const DEFAULT_WORKTREE_ROOT = ".worktrees";

/** The label that makes a ticket a fix rather than a feature. */
const BUG_LABEL = "bug";

/**
 * How much of a title reaches the branch name. A cap rather than the whole title because the branch
 * becomes a directory name under the worktree root, and paths have limits the branch does not.
 */
const SLUG_LIMIT = 48;

/**
 * The branch for one ticket: a `fix` or `feature` prefix, the title as a slug, then the ticket's own
 * key. The key goes last so that tab-completion on the prefix reaches the slug rather than stopping at
 * a run of numbers, which is the whole reason the convention is shaped this way.
 *
 * Lowercased throughout, including a key that carries letters — a Jira `ABC-7` becomes `abc-7`. The
 * branch is a name a person types, not an identifier anything parses back, and the ticket it belongs
 * to is recoverable from the key either way.
 *
 * A title with nothing a branch name can carry — punctuation, or a script this strips — yields the key
 * alone rather than a branch ending in the separator.
 */
export function branchName(ticket: Pick<Ticket, "ref" | "title" | "labels">): string {
	const prefix = ticket.labels.some((label) => label.toLowerCase() === BUG_LABEL) ? "fix" : "feature";
	const slug = slugify(ticket.title);
	const key = slugify(ticket.ref.key);
	if (key === "") {
		throw new WorktreeError(`${ticket.ref.key} has nothing a branch name can carry`, "git");
	}
	return slug === "" ? `${prefix}/${key}` : `${prefix}/${slug}-${key}`;
}

/**
 * Text as one branch-name component: lowercase, runs of anything else collapsed to a single `-`, and
 * cut at a separator rather than mid-word once it passes `SLUG_LIMIT`.
 *
 * The accepted set is ASCII letters and digits and nothing more, so the result cannot contain any of
 * the characters `git check-ref-format` rejects, and cannot end in `.lock` or begin with `.`. An
 * allowlist rather than a denylist of git's rules: the denylist has to stay in step with git, and one
 * that falls behind produces a branch name git refuses.
 */
function slugify(text: string): string {
	const collapsed = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (collapsed.length <= SLUG_LIMIT) return collapsed;
	const cut = collapsed.slice(0, SLUG_LIMIT + 1);
	const boundary = cut.lastIndexOf("-");
	const kept = boundary > 0 ? cut.slice(0, boundary) : collapsed.slice(0, SLUG_LIMIT);
	return kept.replace(/-+$/, "");
}

export interface WorktreePlanInput {
	readonly runner: Runner;
	/** The checkout this tool was invoked in, which is only sometimes the primary one. */
	readonly repo: string;
	readonly branch: string;
	/** Absolute, or relative to the primary checkout. Defaults to `DEFAULT_WORKTREE_ROOT`. */
	readonly root?: string;
}

/**
 * What ensuring the worktree will do, worked out without doing it — the same split as `LaunchPlan`,
 * and here it is load-bearing rather than symmetric: everything the plan reads leaves nothing behind,
 * so a failure while planning can still release the claim, while the command it carries is the first
 * thing that cannot be taken back.
 *
 * `kind` distinguishes the three ways a branch and a worktree can already partly exist, because a run
 * that cut a new branch and one that attached to somebody's existing work are different answers to
 * whoever is reading the output.
 */
export interface WorktreePlan {
	readonly kind: "attached" | "checked-out" | "created";
	readonly path: string;
	readonly branch: string;
	/** The argv that brings the worktree into being; `null` where it is already there. */
	readonly command: readonly string[] | null;
	/** The primary checkout, so a caller can ask what of it a session in the worktree would see. */
	readonly primary: string;
	/** Conditions worth surfacing that are not reasons to refuse. */
	readonly warnings: readonly string[];
}

/**
 * One registered worktree, as `git worktree list --porcelain` describes it. `branch` is null for a
 * detached HEAD, which still occupies the path and still has to be recognised there.
 */
interface Registration {
	readonly path: string;
	readonly branch: string | null;
	/** Set where git reports the registration's directory is gone, which no attach can use. */
	readonly prunable: boolean;
}

/**
 * Works out how to reach the required worktree, reading only.
 *
 * @throws WorktreeError — `"branch-elsewhere"` where the branch is checked out at another path,
 * `"stale-directory"` where the expected path holds anything else, `"git"` where a command failed.
 */
export function planWorktree(input: WorktreePlanInput): WorktreePlan {
	const registrations = readRegistrations(input.runner, input.repo);
	const primary = registrations[0]?.path;
	if (primary === undefined) {
		throw new WorktreeError(`${input.repo} reports no worktrees, so it is not a git checkout`, "git");
	}

	const root = input.root ?? DEFAULT_WORKTREE_ROOT;
	const path = join(isAbsolute(root) ? root : resolve(primary, root), leafOf(input.branch));
	const warnings = driftWarnings(input.runner, primary, registrations[0]!.branch);

	const onBranch = registrations.find((one) => one.branch === input.branch);
	if (onBranch !== undefined && onBranch.path !== path) {
		const where = onBranch.prunable ? `${onBranch.path}, a directory that is gone` : onBranch.path;
		throw new WorktreeError(`${input.branch} is already checked out at ${where}, not at ${path}`, "branch-elsewhere");
	}

	const atPath = registrations.find((one) => one.path === path);
	if (atPath !== undefined) {
		if (atPath.prunable) {
			throw new WorktreeError(
				`${path} is registered as a worktree but the directory is gone; clear it with "git worktree prune"`,
				"stale-directory",
			);
		}
		if (atPath.branch !== input.branch) {
			const on = atPath.branch === null ? "a detached HEAD" : atPath.branch;
			throw new WorktreeError(`${path} is already a worktree on ${on}, not on ${input.branch}`, "stale-directory");
		}
		return { kind: "attached", path, branch: input.branch, command: null, primary, warnings };
	}

	refuseIfOccupied(path);

	// A directory with a worktree at it is the case above, so anything left here is a branch that
	// exists without being checked out anywhere.
	const create = !branchExists(input.runner, primary, input.branch);
	return {
		kind: create ? "created" : "checked-out",
		path,
		branch: input.branch,
		// Cut from the primary checkout's HEAD, which is what `driftWarnings` reports on. Running this
		// from the invoking checkout instead would base the branch on whatever that one happens to be
		// on, which is neither stated anywhere nor visible in the output.
		command: worktreeAddCommand(primary, path, input.branch, create),
		primary,
		warnings,
	};
}

/**
 * Carries out the plan. Separate from `planWorktree` so that a caller can hold a claim across exactly
 * this call and no more: a failure here may leave a directory behind, which is why the claim is kept
 * from this point on rather than given back.
 *
 * @throws WorktreeError `"git"`.
 */
export function ensureWorktree(plan: WorktreePlan, runner: Runner): void {
	if (plan.command === null) return;
	const result = runner([...plan.command]);
	if (result.code !== 0) {
		throw new WorktreeError(`${plan.path} could not be created: ${gitFailure(result.stderr, result.code)}`, "git");
	}
}

/** The last component of a branch name, which is what the branch is called under the worktree root. */
function leafOf(branch: string): string {
	return branch.slice(branch.lastIndexOf("/") + 1);
}

/**
 * @throws WorktreeError `"stale-directory"` where anything at all is at `path`. Emptiness is the one
 * exception, because `git worktree add` accepts an empty directory — refusing it would turn a case git
 * heals on a re-run into one needing a person, which is the opposite of what ensuring is for.
 */
function refuseIfOccupied(path: string): void {
	const entry = statSync(path, { throwIfNoEntry: false });
	if (entry === undefined) return;
	if (!entry.isDirectory()) {
		throw new WorktreeError(`${path} is where the worktree goes, and it is not a directory`, "stale-directory");
	}
	if (readdirSync(path).length > 0) {
		throw new WorktreeError(
			`${path} already holds files and is not a registered worktree; move it aside`,
			"stale-directory",
		);
	}
}

function branchExists(runner: Runner, repo: string, branch: string): boolean {
	// Exit 1 is returned both for a branch that is absent and for a name `--verify` will not accept, so
	// only success answers the question. A name git refuses reaches `git worktree add`, which says so.
	return runner([...branchExistsCommand(repo, branch)]).code === 0;
}

/**
 * Whether the primary checkout has drifted off the default branch, which is worth saying because the
 * new branch is cut from that checkout's HEAD — a worktree stacked on drift inherits it.
 *
 * A default branch that cannot be determined is itself reported. Saying nothing would drop the check
 * silently in exactly the repositories that have no `origin/HEAD` to read, and a caller would have no
 * way to tell that from a checkout sitting on the default branch.
 */
function driftWarnings(runner: Runner, primary: string, branch: string | null): readonly string[] {
	if (branch === null) return [`the primary checkout ${primary} is on a detached HEAD`];

	const result = runner([...defaultBranchCommand(primary)]);
	if (result.code !== 0) {
		return [
			`which branch is the default could not be read from ${primary}, so ${branch} was not checked against it; set it with "git remote set-head origin --auto"`,
		];
	}

	const fallback = result.stdout.trim();
	const head = "refs/remotes/origin/";
	const target = fallback.startsWith(head) ? fallback.slice(head.length) : fallback;
	if (target === branch) return [];
	return [`the primary checkout ${primary} is on ${branch}, not on ${target}`];
}

function readRegistrations(runner: Runner, repo: string): readonly Registration[] {
	const result = runner([...worktreeListCommand(repo)]);
	if (result.code !== 0) {
		throw new WorktreeError(
			`${repo} could not be asked for its worktrees: ${gitFailure(result.stderr, result.code)}`,
			"git",
		);
	}
	return parseWorktreeList(result.stdout);
}

/**
 * The `--porcelain -z` listing: attributes NUL-terminated, records separated by an empty attribute.
 * Split on NUL rather than on newline so that a worktree path containing one is read as the path it
 * is rather than as the start of the next attribute.
 *
 * An attribute this does not recognise is skipped rather than refused. The format is documented as
 * extensible, and a git that has learned a new one is not a reason to stop.
 */
export function parseWorktreeList(text: string): readonly Registration[] {
	const registrations: Registration[] = [];
	let path: string | null = null;
	let branch: string | null = null;
	let prunable = false;

	const close = (): void => {
		if (path !== null) registrations.push({ path, branch, prunable });
		path = null;
		branch = null;
		prunable = false;
	};

	for (const attribute of text.split("\0")) {
		if (attribute === "") {
			close();
			continue;
		}
		const space = attribute.indexOf(" ");
		const name = space === -1 ? attribute : attribute.slice(0, space);
		const value = space === -1 ? "" : attribute.slice(space + 1);
		if (name === "worktree") {
			close();
			path = value;
		} else if (name === "branch") {
			branch = value.startsWith(REF_HEADS) ? value.slice(REF_HEADS.length) : value;
		} else if (name === "prunable") {
			prunable = true;
		}
	}
	close();
	return registrations;
}

const REF_HEADS = "refs/heads/";

/** A git failure as one line, falling back to the exit status where the command said nothing. */
function gitFailure(stderr: string, code: number): string {
	const said = stderr.trim();
	return said === "" ? `git exited ${code}` : said;
}
