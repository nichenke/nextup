import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { branchExistsCommand, defaultBranchCommand, worktreeAddCommand, worktreeListCommand } from "./command-builders";
import type { Runner } from "./runner";
import type { Ticket } from "./ticket";

/**
 * Why a worktree could not be brought into the required state.
 *
 * `"stale-directory"` covers everything occupying the expected path that is not the worktree wanted
 * there — leftover files, a symlink, a registration whose directory has gone, a worktree on another
 * branch — and the message says which. `"ticket-set"` says the ticket cannot name a branch, borrowing
 * `ClaimError`'s word for the same thing: no waiting fixes it. `"git"` is a git question this could
 * not get a usable answer to, which includes a command that succeeded and said nothing.
 */
export class WorktreeError extends Error {
	readonly kind: "stale-directory" | "branch-elsewhere" | "ticket-set" | "git";

	constructor(message: string, kind: WorktreeError["kind"]) {
		super(message);
		this.kind = kind;
	}
}

/**
 * Where worktrees go when nothing else says. Relative, and resolved against the primary checkout, so
 * that a run started from inside one worktree does not nest the next one underneath it. ADR-0013 has
 * why here rather than under the harness's directory.
 */
export const DEFAULT_WORKTREE_ROOT = ".worktrees";

const BUG_LABEL = "bug";

/** How much of a title reaches the branch name, which becomes a directory name under the root. */
const SLUG_LIMIT = 48;

/**
 * The branch for one ticket: a `fix` or `feature` prefix, the title as a slug, then the ticket's own
 * key. The key goes last so that tab-completion on the prefix reaches the slug rather than stopping at
 * a run of numbers, which is the whole reason the convention is shaped this way.
 *
 * @throws WorktreeError `"ticket-set"` where the key does not survive slugification — anything but
 * ASCII letters, digits and separators is dropped, so two keys differing only outside that set would
 * name one branch at one path, and the second ticket would be reported as attached to the first
 * ticket's worktree. Case is not part of the test: a Jira `ABC-7` becomes `abc-7`, because the branch
 * is a name a person types rather than an identifier anything parses back.
 */
export function branchName(ticket: Pick<Ticket, "ref" | "title" | "labels">): string {
	const prefix = ticket.labels.some((label) => label.toLowerCase() === BUG_LABEL) ? "fix" : "feature";
	const key = slugify(ticket.ref.key);
	if (key !== ticket.ref.key.toLowerCase()) {
		throw new WorktreeError(`${ticket.ref.key} cannot be spelled in a branch name, so it would not name its own`, "ticket-set");
	}
	const slug = slugify(ticket.title);
	return slug === "" ? `${prefix}/${key}` : `${prefix}/${slug}-${key}`;
}

/**
 * Text as one branch-name component.
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
	readonly root?: string | null;
}

interface WorktreeBase {
	readonly path: string;
	readonly branch: string;
	/** The primary checkout, so a caller can ask what of it a session in the worktree would see. */
	readonly primary: string;
	/** Conditions worth surfacing that are not reasons to refuse. */
	readonly warnings: readonly string[];
}

/**
 * What ensuring the worktree will do, worked out without doing it.
 *
 * A union rather than one shape with a nullable command, so that a plan claiming to have created
 * something while carrying nothing to run cannot be built: `ensureWorktree` returns on a null command,
 * so such a plan reports success having made no worktree, and the run would print `created` over an
 * empty path. `ReleaseOutcome` in `claim.ts` is the same shape of problem, solved the same way.
 */
export type WorktreePlan =
	| (WorktreeBase & { readonly kind: "attached"; readonly command: null })
	| (WorktreeBase & { readonly kind: "created" | "checked-out"; readonly command: readonly string[] });

/**
 * What a registration's HEAD is, in the shapes the porcelain listing reports.
 *
 * Separate arms rather than a nullable branch name. A bare repository and a detached HEAD are
 * different situations with different answers to "has this drifted?", and flattened into one absent
 * branch a bare primary was reported as "on a detached HEAD" — a checkout it does not have. `"opaque"`
 * is a record naming none of the three, which is a git this does not understand rather than any of
 * them; `CONTEXT.md`'s `Unknown` is the same rule.
 */
type Head =
	| { readonly kind: "branch"; readonly name: string }
	| { readonly kind: "detached" }
	| { readonly kind: "bare" }
	| { readonly kind: "opaque" };

/** One registered worktree, as `git worktree list --porcelain` describes it. */
interface Registration {
	readonly path: string;
	readonly head: Head;
	/** Set where git reports the registration's directory is gone, which no attach can use. */
	readonly prunable: boolean;
}

/**
 * Works out how to reach the required worktree, reading only.
 *
 * @throws WorktreeError — `"branch-elsewhere"` where the branch is checked out at another path,
 * `"stale-directory"` where the expected path holds anything else, `"ticket-set"` from `branchName`,
 * `"git"` where a command failed.
 */
export function planWorktree(input: WorktreePlanInput): WorktreePlan {
	const registrations = readRegistrations(input.runner, input.repo);
	// The main worktree is what the porcelain listing puts first, whichever worktree the listing was
	// asked from — which is the whole reason `repo` and `primary` are separate values here.
	const main = registrations[0];
	if (main === undefined) {
		throw new WorktreeError(`${input.repo} reports no worktrees, so it is not a git checkout`, "git");
	}
	const primary = main.path;

	const root = input.root ?? DEFAULT_WORKTREE_ROOT;
	const container = isAbsolute(root) ? root : resolve(primary, root);
	refuseIfReachedThroughLink(container);
	const path = join(container, leafOf(input.branch));
	const warnings = driftWarnings(input.runner, primary, main.head);

	const onBranch = registrations.find((one) => one.head.kind === "branch" && one.head.name === input.branch);
	if (onBranch !== undefined && onBranch.path !== path) {
		const where = onBranch.prunable ? `${onBranch.path}, a directory that is gone` : onBranch.path;
		throw new WorktreeError(`${input.branch} is already checked out at ${where}, not at ${path}`, "branch-elsewhere");
	}

	const atPath = registrations.find((one) => one.path === path);
	if (atPath !== undefined) {
		if (atPath.prunable) {
			// Refused rather than healed, though `git worktree prune` would clear it: prune takes no path
			// and would drop every other stale registration in the repository, and it writes, which this
			// half of the step may not do — the claim is given back on a failure here.
			throw new WorktreeError(
				`${path} is registered as a worktree but the directory is gone; clear it with "git worktree prune"`,
				"stale-directory",
			);
		}
		if (atPath.head.kind !== "branch" || atPath.head.name !== input.branch) {
			throw new WorktreeError(`${path} is already a worktree on ${describe(atPath.head)}, not on ${input.branch}`, "stale-directory");
		}
		return { kind: "attached", path, branch: input.branch, command: null, primary, warnings };
	}

	refuseIfOccupied(path);

	// A registered worktree at the path is the case above, so a branch that exists at this point is one
	// checked out nowhere.
	const create = !branchExists(input.runner, primary, input.branch);
	return {
		kind: create ? "created" : "checked-out",
		path,
		branch: input.branch,
		// primary, not input.repo — see `driftWarnings`.
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

function describe(head: Head): string {
	if (head.kind === "branch") return head.name;
	if (head.kind === "bare") return "a bare repository";
	return head.kind === "detached" ? "a detached HEAD" : "a head this could not read";
}

/**
 * @throws WorktreeError `"stale-directory"` where anything at all is at `path`, an empty directory
 * excepted — `git worktree add` accepts one of those, and refusing it would turn a case a re-run heals
 * into one needing a person, which is the opposite of what ensuring is for.
 *
 * Asked with `lstat`, which does not follow the link, so a symlink is refused whether or not it
 * resolves. `stat` follows, and on a dangling one it answers that nothing is there — the run then went
 * on to a `git worktree add` that refuses it, arriving as an unclassified git failure after the claim
 * boundary rather than as this refusal before it.
 */
function refuseIfOccupied(path: string): void {
	let entry;
	try {
		entry = lstatSync(path, { throwIfNoEntry: false });
	} catch (cause) {
		// `throwIfNoEntry` covers a path that is not there; it does not cover a path that cannot be
		// asked about, which is what an ancestor being a file (ENOTDIR) or unreadable (EACCES) gives.
		// Raw, that error is not a WorktreeError and no caller catches it, so the command died rather
		// than reporting the refusal it documents.
		throw new WorktreeError(`${path} could not be inspected: ${message(cause)}`, "stale-directory");
	}
	if (entry === undefined) return;
	if (entry.isSymbolicLink()) {
		throw new WorktreeError(`${path} is a symlink; a worktree has to be the directory itself`, "stale-directory");
	}
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

/**
 * @throws WorktreeError `"git"` where the repository could not answer. Exit 1 is "no such ref", and is
 * also what a name `--verify --quiet` will not accept returns, so both count as absent — such a name
 * reaches `git worktree add`, which says so. Every other status is the repository failing rather than
 * answering, and 128 is what it uses; read as absent, that failure would surface at the add instead,
 * which runs past the point where the claim is given back.
 */
function branchExists(runner: Runner, repo: string, branch: string): boolean {
	const result = runner([...branchExistsCommand(repo, branch)]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new WorktreeError(
		`${repo} could not be asked whether ${branch} exists: ${gitFailure(result.stderr, result.code)}`,
		"git",
	);
}

/**
 * @throws WorktreeError `"stale-directory"` where any part of `root` is a symlink.
 *
 * git registers a worktree under the path with its symlinks resolved, so a root reached through one
 * registers as a path this would look for elsewhere, and the next run reports the branch checked out
 * somewhere else rather than attaching to what the last one made. Refused rather than resolved: a
 * worktree root reached through a link is not something this tool needs to support, and following one
 * would leave two names for the same directory with only one of them ever matching git.
 */
function refuseIfReachedThroughLink(root: string): void {
	const resolved = canonicalize(root);
	if (resolved !== root) {
		throw new WorktreeError(`${root} is reached through a symlink, which resolves to ${resolved}`, "stale-directory");
	}
}

/**
 * `path` with the symlinks in it resolved. Resolves the deepest part that exists and re-appends the
 * rest, because the directory being asked about need not be there yet.
 */
function canonicalize(path: string): string {
	const tail: string[] = [];
	let head = path;
	for (;;) {
		try {
			return join(realpathSync(head), ...tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

/**
 * Whether the primary checkout has drifted off the default branch, which is worth saying because the
 * new branch is cut from that checkout's HEAD — a worktree stacked on drift inherits it.
 *
 * A default branch that cannot be determined is itself reported. Saying nothing would drop the check
 * silently in exactly the repositories that have no `origin/HEAD` to read, and a caller would have no
 * way to tell that from a checkout sitting on the default branch.
 */
function driftWarnings(runner: Runner, primary: string, head: Head): readonly string[] {
	if (head.kind === "bare") return [`${primary} is a bare repository, so it has no checkout to compare against a default branch`];
	if (head.kind !== "branch") return [`the primary checkout ${primary} is on ${describe(head)}`];

	const result = runner([...defaultBranchCommand(primary)]);
	if (result.code !== 0) {
		return [
			`which branch is the default could not be read from ${primary}, so ${head.name} was not checked against it; set it with "git remote set-head origin --auto"`,
		];
	}

	const target = result.stdout.trim().slice(REMOTE_HEAD.length);
	if (target === head.name) return [];
	return [`the primary checkout ${primary} is on ${head.name}, not on ${target}`];
}

const REMOTE_HEAD = "refs/remotes/origin/";

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
 * The `--porcelain -z` listing: attributes NUL-terminated, records closed by an empty one. Split on
 * NUL rather than on newline because a worktree path may contain one, and the line form prints it raw
 * — the second line is then indistinguishable from the next attribute.
 *
 * An attribute this does not recognise is skipped rather than refused. The format is documented as
 * extensible, and a git that has learned a new one is not a reason to stop; a record naming no head at
 * all becomes `"opaque"` rather than any particular one.
 */
export function parseWorktreeList(text: string): readonly Registration[] {
	const registrations: Registration[] = [];
	let path: string | null = null;
	let head: Head = { kind: "opaque" };
	let prunable = false;

	const close = (): void => {
		if (path !== null) registrations.push({ path, head, prunable });
		path = null;
		head = { kind: "opaque" };
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
			head = { kind: "branch", name: value.startsWith(REF_HEADS) ? value.slice(REF_HEADS.length) : value };
		} else if (name === "detached") {
			head = { kind: "detached" };
		} else if (name === "bare") {
			head = { kind: "bare" };
		} else if (name === "prunable") {
			prunable = true;
		}
	}
	close();
	return registrations;
}

const REF_HEADS = "refs/heads/";

function gitFailure(stderr: string, code: number): string {
	const said = stderr.trim();
	return said === "" ? `git exited ${code}` : said;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
