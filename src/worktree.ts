import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Argv,
	branchExistsCommand,
	defaultBranchCommand,
	remoteBranchExistsCommand,
	worktreeAddCommand,
	worktreeListCommand,
} from "./command-builders";
import type { Runner } from "./runner";
import type { Ticket } from "./ticket";

/**
 * Why a worktree could not be brought into the required state.
 *
 * The two path kinds split on *which* path is wrong, which is easy to read backwards.
 * `"stale-directory"` is the expected path holding something that is not the worktree wanted there —
 * leftover files, a symlink, a registration whose directory has gone, a worktree there on some other
 * branch, a root that names no place a worktree can go — and the message says which.
 * `"branch-elsewhere"` is the reverse: this ticket's own branch checked out at a different path, which
 * is the refusal a second session racing the same ticket hits. `"unnameable-ticket"` says the ticket
 * cannot name a branch at all — an absent key, or one no branch name can spell — so
 * no waiting fixes it; it is deliberately not called `ticket-set`, which `CONTEXT.md` gives to the
 * tickets one invocation considers. `"git"` is a git question this could not get a usable answer to,
 * which includes a command that succeeded and said nothing.
 */
export class WorktreeError extends Error {
	readonly kind: "stale-directory" | "branch-elsewhere" | "unnameable-ticket" | "git";

	constructor(message: string, kind: WorktreeError["kind"]) {
		super(message);
		this.kind = kind;
	}
}

/** Where worktrees go when nothing else says. Relative, resolved against the primary checkout — ADR-0013. */
export const DEFAULT_WORKTREE_ROOT = ".worktrees";

const BUG_LABEL = "bug";

/** How much of the title reaches the branch name, which becomes a directory name under the root. */
const SLUG_LIMIT = 48;

/**
 * The branch for one ticket: a `fix` or `feature` prefix, the title as a slug, then the ticket's own
 * key. The key goes last so that tab-completion on the prefix reaches the slug rather than stopping at
 * a run of numbers, which is the whole reason the convention is shaped this way.
 *
 * @throws WorktreeError `"unnameable-ticket"` where the key does not survive slugification — anything but
 * ASCII letters, digits and separators is dropped, so two keys differing only outside that set would
 * name one branch at one path, and the second ticket would be reported as attached to the first
 * ticket's worktree. Case is not part of the test: a Jira `ABC-7` becomes `abc-7`, because the branch
 * is a name a person types rather than an identifier anything parses back.
 */
export function branchName(ticket: Pick<Ticket, "ref" | "title" | "labels">): string {
	const prefix = ticket.labels.some((label) => label.toLowerCase() === BUG_LABEL) ? "fix" : "feature";
	// Normalized without the length limit, which applies to the title alone. Truncating a key would both
	// refuse a long-keyed tracker as unspellable — the wrong cause, and no fix a person could act on — and
	// land two keys sharing their first 48 characters on one branch.
	const key = normalize(ticket.ref.key);
	if (key === "") {
		// An empty key survives slugification trivially, so it needs its own refusal. With an unslugifiable
		// title it produces `feature/`, whose empty component `git check-ref-format` rejects and whose empty
		// last component collapses the worktree path onto the root — the whole root, not a directory in it.
		throw new WorktreeError("a ticket with no key cannot name a branch", "unnameable-ticket");
	}
	if (key !== ticket.ref.key.toLowerCase()) {
		throw new WorktreeError(
			`${ticket.ref.key} cannot be spelled in a branch name, so it would not name its own`,
			"unnameable-ticket",
		);
	}
	const slug = slugify(ticket.title);
	return slug === "" ? `${prefix}/${key}` : `${prefix}/${slug}-${key}`;
}

/**
 * Text reduced to characters a branch name can carry, at any length.
 *
 * The accepted set is ASCII letters and digits and nothing more, so no character `git
 * check-ref-format` rejects survives, and the result cannot end in `.lock` or begin with `.`. An
 * allowlist rather than a denylist of git's rules: the denylist has to stay in step with git, and one
 * that falls behind produces a branch name git refuses.
 *
 * Not sufficient on its own: text with nothing in the accepted set returns `""`, and an empty component
 * is the one thing `check-ref-format` still rejects. `branchName` is where that is refused.
 */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** `normalize`, cut to `SLUG_LIMIT` at a separator rather than mid-word. */
function slugify(text: string): string {
	const collapsed = normalize(text);
	if (collapsed.length <= SLUG_LIMIT) return collapsed;
	const cut = collapsed.slice(0, SLUG_LIMIT + 1);
	const boundary = cut.lastIndexOf("-");
	const kept = boundary > 0 ? cut.slice(0, boundary) : collapsed.slice(0, SLUG_LIMIT);
	return kept.replace(/-+$/, "");
}

export interface EnsureInput {
	readonly runner: Runner;
	/** The checkout this tool was invoked in, which is only sometimes the primary one. */
	readonly repo: string;
	readonly ticket: Pick<Ticket, "ref" | "title" | "labels">;
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
 * What ensuring the worktree did.
 *
 * A union rather than one shape with a nullable command, and `Argv` rather than `readonly string[]`, so
 * that an outcome claiming to have created something while carrying nothing that ran cannot be built —
 * the shape nichenke/nextup pull request 31 shipped and which reported `created` over an empty path.
 */
export type WorktreeOutcome =
	| (WorktreeBase & { readonly kind: "attached"; readonly command: null })
	| (WorktreeBase & { readonly kind: "created" | "checked-out"; readonly command: Argv });

/**
 * What a registration's HEAD is, in the shapes the porcelain listing reports.
 *
 * Separate arms rather than a nullable branch name. A bare repository and a detached HEAD are different
 * situations with different answers to "has this drifted?", and flattened into one absent branch a bare
 * primary was reported as "on a detached HEAD" — a checkout it does not have.
 *
 * `"opaque"` is a record naming none of the other three. No git reached here produces one — 2.55 emits
 * `branch`, `detached` or `bare` for every shape, including an unborn HEAD, which reports `branch` —
 * so it is not there to cover a git that has learned a fourth. It is there because `parseWorktreeList`
 * has to hold a head before it has read any attribute, and the alternative initial value is the
 * nullable this union replaced. `CONTEXT.md`'s `Unknown` is the same rule: a state meaning "could not
 * tell" is never spelled as one of the states it is not.
 */
export type Head =
	| { readonly kind: "branch"; readonly name: string }
	| { readonly kind: "detached" }
	| { readonly kind: "bare" }
	| { readonly kind: "opaque" };

/** One registered worktree, as `git worktree list --porcelain` describes it. */
export interface Registration {
	readonly path: string;
	readonly head: Head;
	/** Set where git reports the registration's directory is gone, which no attach can use. */
	readonly prunable: boolean;
	/** Locked worktrees are never reported prunable, so this changes what clearing one takes. */
	readonly locked: boolean;
}

/**
 * Brings the ticket's worktree into the required state, and says which of three things that took.
 *
 * Idempotent, which is what makes it the whole step rather than a plan and a commit: a re-run after
 * any failure attaches to whatever is already there and carries on, so recovery is the ordinary path.
 * ADR-0016 has why nothing here needs unwinding.
 *
 * @throws WorktreeError — `"branch-elsewhere"` where the branch is checked out at another path,
 * `"stale-directory"` where the expected path holds anything else, `"unnameable-ticket"` from `branchName`,
 * `"git"` where a command failed.
 */
export function ensure(input: EnsureInput): WorktreeOutcome {
	const branch = branchName(input.ticket);
	const registrations = readRegistrations(input.runner, input.repo);
	// The main worktree is what the porcelain listing puts first, whichever worktree the listing was
	// asked from — which is the whole reason `repo` and `primary` are separate values here.
	const main = registrations[0];
	if (main === undefined) {
		throw new WorktreeError(`${input.repo} reports no worktrees, so it is not a git checkout`, "git");
	}
	const primary = main.path;

	// `resolve` takes an absolute root as given and a relative one against the primary checkout, and
	// normalizes either — so a trailing slash or a `..` in a caller's root is the same path rather than
	// a different spelling of it.
	// Blank counts as unset. `??` does not fire for `""`, which is what an unset variable or an empty flag
	// hands over, and `resolve` discards an empty segment — so a blank root became the primary checkout
	// rather than the default.
	const container = resolve(primary, input.root?.trim() || DEFAULT_WORKTREE_ROOT);
	if (container === primary) {
		// What `"."` and the primary's own path still reach. Refused because worktrees would land beside the
		// checkout's own tracked files at its top level, where nothing ignores them — not because the root
		// is inside the working tree, which ADR-0013's default `.worktrees` also is, deliberately. A root
		// pointed anywhere else inside the checkout is taken as given, tracked directory or not.
		throw new WorktreeError(`${primary} is the primary checkout, so it cannot also be the worktree root`, "stale-directory");
	}
	refuseIfReachedThroughLink(container);
	const path = join(container, leafOf(branch));

	const onBranch = registrations.find((one) => one.head.kind === "branch" && one.head.name === branch);
	if (onBranch !== undefined && onBranch.path !== path) {
		const where = gone(onBranch) ? `${onBranch.path}, a directory that is not there` : onBranch.path;
		throw new WorktreeError(`${branch} is already checked out at ${where}, not at ${path}`, "branch-elsewhere");
	}

	const atPath = registrations.find((one) => one.path === path);
	if (atPath !== undefined) {
		refuseUnlessAttachable(atPath, path, branch);
		// Asked only on the routes that return, since it spawns a process whose answer every refusal above
		// would discard — and re-running onto an existing worktree is the ordinary path here, not the rare one.
		return { kind: "attached", path, branch, command: null, primary, warnings: driftWarnings(input.runner, primary, main.head) };
	}

	refuseIfOccupied(path);

	// A registered worktree at the path is the case above, so a branch that exists at this point is one
	// checked out nowhere. `origin` is asked too, and a branch only there is checked out rather than
	// created: `-b` would cut a new branch from local HEAD and leave every pushed commit behind, while the
	// no-`-b` form takes the remote tip and sets up tracking.
	const create =
		!branchExists(input.runner, primary, branch, branchExistsCommand) &&
		!branchExists(input.runner, primary, branch, remoteBranchExistsCommand);
	const warnings = driftWarnings(input.runner, primary, main.head);
	// primary, not input.repo — see `driftWarnings`.
	const command = worktreeAddCommand(primary, path, branch, create);
	const result = input.runner([...command]);
	if (result.code !== 0) {
		throw new WorktreeError(`${path} could not be created: ${gitFailure(result.stderr, result.code)}`, "git");
	}
	return { kind: create ? "created" : "checked-out", path, branch, command, primary, warnings };
}

/**
 * @throws WorktreeError `"stale-directory"` where the registration at `path` is not a worktree on
 * `branch` that something could be done in.
 *
 * A registration is git's record of a path, not a promise about what is at it now, so the create path's
 * invariants are re-asked here rather than skipped: both routes into the worktree have to enforce them,
 * and `gone` alone is satisfied by a file that replaced a deleted worktree.
 */
function refuseUnlessAttachable(registration: Registration, path: string, branch: string): void {
	if (gone(registration)) {
		// Refused rather than healed, though `git worktree prune` would clear an unlocked one: prune takes
		// no path, so it would also drop every other stale registration in the repository.
		const unlock = registration.locked ? "unlock it and " : "";
		throw new WorktreeError(
			`${path} is registered as a worktree but the directory is not there; ${unlock}clear it with "git worktree prune"`,
			"stale-directory",
		);
	}
	if (registration.head.kind !== "branch" || registration.head.name !== branch) {
		throw new WorktreeError(
			`${path} is already a worktree on ${describe(registration.head)}, not on ${branch}`,
			"stale-directory",
		);
	}
	if (inspectUsable(path, "is registered as a worktree but is not a directory") === undefined) {
		// `gone` above already refuses an absent path, so reaching here means it went away in between the
		// two calls. Said plainly rather than left to `git worktree add`, which is not run on this route.
		throw new WorktreeError(`${path} is registered as a worktree but went away while being checked`, "stale-directory");
	}
}

/** The last component of a branch name, which is what the branch is called under the worktree root. */
function leafOf(branch: string): string {
	return branch.slice(branch.lastIndexOf("/") + 1);
}

/**
 * Whether a registration names a directory that is not there. Asked of the filesystem rather than read
 * off `prunable`, which git does not set on a locked worktree however missing its directory is: trusting
 * that attribute reports an attach to a path holding nothing, and claims a worktree that was never made.
 */
function gone(registration: Registration): boolean {
	return registration.prunable || !existsSync(registration.path);
}

function describe(head: Head): string {
	// A switch closed by `never`, so a fifth arm is a compile error rather than something rendered as
	// "could not read" — mislabelled as opaque is the collapse the union exists to prevent.
	switch (head.kind) {
		case "branch":
			return head.name;
		case "bare":
			return "a bare repository";
		case "detached":
			return "a detached HEAD";
		case "opaque":
			return "a head this could not read";
		default: {
			const unreachable: never = head;
			return unreachable;
		}
	}
}

/**
 * @throws WorktreeError `"stale-directory"` where anything at all is at `path`, an empty directory
 * excepted — `git worktree add` accepts one of those, and refusing it would turn a case a re-run heals
 * into one needing a person, which is the opposite of what ensuring is for.
 *
 * Asked with `lstat`, which does not follow the link, so a symlink is refused whether or not it resolves.
 * `stat` follows, and on a dangling one it answers that nothing is there; the run then reaches a `git
 * worktree add` that refuses the path anyway, turning this typed refusal into an unclassified git fatal.
 */
function refuseIfOccupied(path: string): void {
	if (inspectUsable(path, "is where the worktree goes, and it is not a directory") === undefined) return;
	if (asking(path, "listed", () => readdirSync(path)).length > 0) {
		throw new WorktreeError(`${path} already holds files and is not a registered worktree; move it aside`, "stale-directory");
	}
}

/**
 * What is at `path`, having refused it unless a worktree could be there: absent is allowed and reported
 * as `undefined`, a symlink and a non-directory are not. `complaint` says what the caller wanted it for.
 *
 * The one guard both the attach and the create route go through, rather than the same three checks
 * written twice. Written twice, they drifted: the symlink refusal held on the create route only, and an
 * attach to a symlinked path went through — so a third check added to one and not the other is the
 * failure mode this shape exists to make impossible.
 *
 * @throws WorktreeError `"stale-directory"`.
 */
function inspectUsable(path: string, complaint: string): ReturnType<typeof lstatSync> | undefined {
	const entry = inspect(path);
	if (entry?.isSymbolicLink() === true) {
		throw new WorktreeError(`${path} is a symlink; a worktree has to be the directory itself`, "stale-directory");
	}
	if (entry !== undefined && !entry.isDirectory()) {
		throw new WorktreeError(`${path} ${complaint}`, "stale-directory");
	}
	return entry;
}

function inspect(path: string): ReturnType<typeof lstatSync> | undefined {
	return asking(path, "inspected", () => lstatSync(path, { throwIfNoEntry: false }));
}

/**
 * Every filesystem question this guard asks, classified. `throwIfNoEntry` covers a path that is not
 * there and nothing else, so an ancestor that is a file (ENOTDIR), a directory that cannot be read
 * (EACCES), or a path that goes away mid-check all raise a plain error — which no caller catches, so
 * the command dies rather than reporting the refusal this documents. One wrapper rather than a
 * try/catch per call site, so a filesystem question added later cannot escape unclassified.
 */
function asking<T>(path: string, verb: string, work: () => T): T {
	try {
		return work();
	} catch (cause) {
		throw new WorktreeError(`${path} could not be ${verb}: ${message(cause)}`, "stale-directory");
	}
}

/**
 * @throws WorktreeError `"git"` where the repository could not answer. Exit 1 is "no such ref", and is
 * also what a name `--verify --quiet` will not accept returns, so both count as absent — such a name
 * reaches `git worktree add`, which says so. Every other status is the repository failing rather than
 * answering, and 128 is what it uses; read as absent, that failure would arrive as `git worktree add`'s
 * own unclassified fatal instead of as this typed refusal.
 */
function branchExists(
	runner: Runner,
	repo: string,
	branch: string,
	build: (repo: string, branch: string) => readonly string[],
): boolean {
	const result = runner([...build(repo, branch)]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new WorktreeError(`${repo} could not be asked whether ${branch} exists: ${gitFailure(result.stderr, result.code)}`, "git");
}

/**
 * @throws WorktreeError `"stale-directory"` where any component of `root` is a symlink.
 *
 * Refused rather than resolved, per ADR-0013: git registers a worktree under the path with its symlinks
 * resolved, so a root reached through one registers where this would not look for it, and the next run
 * reports the branch checked out elsewhere instead of attaching to what the last one made.
 *
 * Asked component by component rather than by comparing the path against its resolved form. That
 * comparison cannot tell a dangling symlink from a component that does not exist yet — both make
 * `realpath` raise `ENOENT` — and it also rejects a path merely spelled differently, such as one
 * carrying the trailing slash a shell completion adds.
 *
 * Walking to `/` costs ADR-0013 the absolute root it promises in the same breath: on macOS `/tmp`,
 * `/var` and `/etc` are symlinks, so every root under a system temp directory is refused. Inert for the
 * default, which git hands back already resolved. nichenke/nextup issue 39 owes the decision.
 */
function refuseIfReachedThroughLink(root: string): void {
	let at = root;
	for (;;) {
		if (inspect(at)?.isSymbolicLink() === true) {
			throw new WorktreeError(`${at} is a symlink, and a worktree root has to be reached without one`, "stale-directory");
		}
		const parent = dirname(at);
		if (parent === at) return;
		at = parent;
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
	if (head.kind === "bare") {
		return [`${primary} is a bare repository, so it has no checkout to compare against a default branch`];
	}
	if (head.kind !== "branch") return [`the primary checkout ${primary} is on ${describe(head)}`];

	const result = runner([...defaultBranchCommand(primary)]);
	if (result.code !== 0) {
		return [
			`which branch is the default could not be read from ${primary}, so ${head.name} was not checked against it; set it with "git remote set-head origin --auto"`,
		];
	}

	// The prefix is checked rather than assumed: `symbolic-ref` accepts `refs/remotes/origin/HEAD` pointed
	// at a local `refs/heads/main`, and slicing a fixed 20 characters off that leaves an empty name — a
	// warning saying the checkout drifted off nothing, for a checkout sitting on the default branch.
	const said = result.stdout.trim();
	if (!said.startsWith(REMOTE_HEAD) || said === REMOTE_HEAD) {
		return [`${primary} named ${said === "" ? "nothing" : said} as its default branch, which is not a branch on origin`];
	}

	const target = said.slice(REMOTE_HEAD.length);
	if (target === head.name) return [];
	return [`the primary checkout ${primary} is on ${head.name}, not on ${target}`];
}

const REMOTE_HEAD = "refs/remotes/origin/";

function readRegistrations(runner: Runner, repo: string): readonly Registration[] {
	const result = runner([...worktreeListCommand(repo)]);
	if (result.code !== 0) {
		throw new WorktreeError(`${repo} could not be asked for its worktrees: ${gitFailure(result.stderr, result.code)}`, "git");
	}
	return parseWorktreeList(result.stdout);
}

/**
 * The `--porcelain -z` listing: attributes NUL-terminated, records closed by an empty one. Split on
 * NUL rather than on newline because a worktree path may contain one, and the line form prints it raw
 * — the second line is then indistinguishable from the next attribute.
 *
 * An attribute this does not recognise is skipped rather than refused, so a label nothing here reads
 * cannot cost the ones it does. Not because the format is open — `git worktree --help` promises the
 * opposite, that it "will remain stable across Git versions" — but because refusing the whole listing
 * is a worse answer to a label that changes none of what this decides.
 */
export function parseWorktreeList(text: string): readonly Registration[] {
	const registrations: Registration[] = [];
	let path: string | null = null;
	let head: Head = { kind: "opaque" };
	let prunable = false;
	let locked = false;

	const close = (): void => {
		if (path !== null) registrations.push({ path, head, prunable, locked });
		path = null;
		head = { kind: "opaque" };
		prunable = false;
		locked = false;
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
		} else if (name === "locked") {
			locked = true;
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
