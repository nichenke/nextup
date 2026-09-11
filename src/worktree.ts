import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
	type Argv,
	refExistsCommand,
	defaultBranchCommand,
	gitCommonDirCommand,
	remoteBranchesCommand,
	worktreeAddCommand,
	worktreeIdentityCommand,
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
 * takes a differing root or a checkout somebody made by hand — two sessions racing one ticket at one root
 * compute the same path, so they collide inside `git worktree add` instead. `"unnameable-ticket"` says the ticket
 * cannot name a branch at all — an absent key, or one no branch name can spell — so
 * no waiting fixes it. `"unsupported-repository"` is a repository laid out in a way this does not work
 * in at all, which no root or ticket changes. `"git"` is a git question this could not get a usable
 * answer to, which includes a command that succeeded and said nothing.
 */
export class WorktreeError extends Error {
	readonly kind: "stale-directory" | "branch-elsewhere" | "unnameable-ticket" | "unsupported-repository" | "git";

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
 *
 * Reads the key and the title only, never `ref.tracker`, `ref.host` or `ref.repo` — so two tickets
 * agreeing on key, slug and bug-labelledness reach that same collision by a route this guard does not
 * cover. Unreachable until a ticket set can span repositories; nichenke/nextup issue 40 owes the choice
 * between qualifying the branch and keying the path on the reference.
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
			`${ticket.ref.key} carries characters a branch name here does not (letters, digits and _ only), so it would not name its own branch`,
			"unnameable-ticket",
		);
	}
	const slug = slugify(ticket.title);
	return slug === "" ? `${prefix}/${key}` : `${prefix}/${slug}-${key}`;
}

/**
 * Text reduced to characters a branch name can carry, at any length.
 *
 * The accepted set is ASCII letters, digits and `_`, so no character `git check-ref-format` rejects
 * survives, and the result cannot end in `.lock` or begin with `.`. An allowlist rather than a denylist
 * of git's rules: the denylist has to stay in step with git, and one that falls behind produces a branch
 * name git refuses.
 *
 * The set is narrower than git's, so a key git would accept can still fail `branchName`'s survival test:
 * `_` is included because `git check-ref-format --branch feature/proj_12` exits 0, leading, trailing and
 * doubled underscores included. Widening it collapses fewer distinct keys onto one name, so it does not
 * weaken that test. No reachable key needs it today — `resolveTicketRef` admits only digits for github
 * and gitlab, and `PROJECT-<number>` for Jira.
 *
 * Not sufficient on its own: text with nothing in the accepted set returns `""`, which `branchName`
 * refuses rather than spell into a name.
 */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * `normalize`, cut to `SLUG_LIMIT` at a separator rather than mid-word.
 *
 * Shares `normalize` with the key, so the `_` admitted for keys reaches titles too: `snake_case_title`
 * slugs to itself rather than to `snake-case-title`. Kept deliberately — it is closer to the title a
 * person wrote, and git takes it — so narrowing the set back to keys alone would change every branch
 * and directory name derived from a title carrying one.
 */
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
 * `"unsupported-repository"` where the repository keeps its git directory somewhere this cannot work,
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
	const gitDir = refuseUnlessOrdinaryLayout(input.runner, main);

	const path = join(resolveContainer(primary, input.root, gitDir), leafOf(branch));

	const onBranch = registrations.find((one) => one.head.kind === "branch" && one.head.name === branch);
	if (onBranch !== undefined && onBranch.path !== path) {
		const where = gone(onBranch) ? `${onBranch.path}, a directory that is not there` : onBranch.path;
		throw new WorktreeError(`${branch} is already checked out at ${where}, not at ${path}`, "branch-elsewhere");
	}

	const atPath = registrations.find((one) => one.path === path);
	if (atPath !== undefined) {
		refuseUnlessAttachable(input.runner, atPath, path, branch);
		// Asked only on the routes that return, since it spawns a process whose answer every refusal above
		// would discard — and re-running onto an existing worktree is the ordinary path here, not the rare one.
		return { kind: "attached", path, branch, command: null, primary, warnings: driftWarnings(input.runner, primary, main.head) };
	}

	refuseIfOccupied(path);

	// A registered worktree at the path is the case above, so a branch that exists at this point is one
	// checked out nowhere. The remotes are asked too, for the reason `remoteBranchesCommand` gives.
	const create =
		!branchExists(input.runner, primary, branch) && !adoptableFromOrigin(input.runner, primary, branch);
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
function refuseUnlessAttachable(runner: Runner, registration: Registration, path: string, branch: string): void {
	if (registration.locked) {
		// Locking is what makes `gone` unreliable: git suppresses `prunable` on a locked worktree however
		// broken it is, so a locked one whose `.git` link had been deleted looked attachable while holding no
		// link at all. Git run there then walks up to the primary checkout — which the default root sits
		// inside — so the run reported the ticket branch while git in that directory reported the primary's.
		// Unlocked, git reports `prunable` and `gone` below already refuses. Nothing here locks a worktree, so
		// the whole shape is turned away rather than each way it can mislead being chased down.
		throw new WorktreeError(`${path} is a locked worktree, which this does not work in; unlock it first`, "stale-directory");
	}
	if (gone(registration)) {
		// Refused rather than healed, though `git worktree prune` would clear it: prune takes no path, so it
		// would also drop every other stale registration in the repository.
		throw new WorktreeError(
			`${path} is registered as a worktree but the directory is not there; clear it with "git worktree prune"`,
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
	refuseUnlessOurs(runner, path, branch);
}

/**
 * @throws WorktreeError `"unsupported-repository"` unless the repository keeps its administration where
 * this tool assumes — `<primary>/.git`, or the primary itself when bare. ADR-0025 has why such a
 * repository is turned away rather than supported, and why bareness is what separates the two accepted
 * shapes from the refused one.
 *
 * @throws WorktreeError `"git"` where the repository could not say, an empty answer included.
 */
function refuseUnlessOrdinaryLayout(runner: Runner, main: Registration): string {
	const primary = main.path;
	const result = runner([...gitCommonDirCommand(primary)]);
	if (result.code !== 0 || result.stdout.trim() === "") {
		throw new WorktreeError(
			`${primary} could not be asked where it keeps its git directory: ${gitFailure(result.stderr, result.code)}`,
			"git",
		);
	}
	const common = result.stdout.trim();
	if (common === join(primary, ".git")) return common;
	if (common === primary && main.head.kind === "bare") return common;
	throw new WorktreeError(
		`${primary} keeps its git directory at ${common}, which this does not work in`,
		"unsupported-repository",
	);
}

/**
 * The directory worktrees go in, with every rule about a root applied.
 *
 * An absolute root is taken as given and a relative one is read against the primary checkout; either is
 * then canonicalized, so a trailing slash, a `.` and a `..` are the same path rather than three spellings
 * of it. A blank root — what an unset variable or an empty flag hands over — means the default rather than
 * the primary checkout itself.
 *
 * Blankness is detected by trimming, and a root that is not blank is then read untrimmed. Whitespace can
 * be part of a directory's name, so trimming one away would name a different path than the caller gave
 * while reporting success — the opposite of taking an absolute root as given.
 *
 * @throws WorktreeError `"stale-directory"` for the two roots no caller wants:
 *
 * - **The primary checkout itself**, which `"."` also reaches. Worktrees would land beside the checkout's
 *   own tracked files at its top level, where nothing ignores them. Not because the root is inside the
 *   working tree — ADR-0013's default `.worktrees` is too, deliberately — so a root pointed anywhere else
 *   inside the checkout is taken as given, tracked directory or not.
 * - **Inside this repository's git directory**, which puts git's own administration (`HEAD`, `index`,
 *   `index.lock`, `commondir`) into the session's working tree as untracked files, where `git clean -fd`
 *   deletes them and `git add -A` commits them. Compared against the directory `refuseUnlessOrdinaryLayout`
 *   read, rather than against any component spelled `.git`: a checkout can legitimately live under an
 *   ancestor of that name — `/srv/.git/repo` keeps its administration at `/srv/.git/repo/.git` — and a
 *   component scan refused it. Skipped for a bare repository, whose git directory *is* the primary, so
 *   containment would hold for every root including the default — the exemption ADR-0025 records.
 *
 * Both are compared against the canonical container rather than the spelling given, so neither is escaped
 * by a root reaching its target through a symlink. `canonical` also refuses a root the filesystem will not
 * answer for. A root merely outside the checkout is not refused — ADR-0041 records that as deliberate.
 */
function resolveContainer(primary: string, root: string | null | undefined, gitDir: string): string {
	const given = root ?? "";
	const named = given.trim() === "" ? DEFAULT_WORKTREE_ROOT : given;
	const container = canonical(isAbsolute(named) ? named : `${primary}${sep}${named}`);
	if (folded(container) === folded(primary)) {
		throw new WorktreeError(`${primary} is the primary checkout, so it cannot also be the worktree root`, "stale-directory");
	}
	if (gitDir !== primary && within(container, gitDir)) {
		throw new WorktreeError(`${container} is inside ${gitDir}, which a worktree cannot be`, "stale-directory");
	}
	return container;
}

/**
 * A path or path component lowered for comparison. A bare helper rather than a comparison claiming a
 * policy, because folding is safe in opposite directions at its two kinds of use: `resolveContainer` folds
 * to refuse *more*, and the only thing it newly rejects is a genuinely distinct `.GIT` directory on a
 * case-sensitive filesystem; `adoptableFromOrigin` folds a remote's name to *accept* a differently-cased
 * `Origin`, which is the same remote by intent.
 *
 * The path matching in `ensure` is deliberately not folded. It decides which worktree to attach to, so on
 * a case-sensitive filesystem folding would attach to a different directory than the one asked for —
 * failing open, where these fail closed. Closing that would need to know whether the filesystem folds,
 * which this does not ask.
 */
function folded(path: string): string {
	return path.toLowerCase();
}

/**
 * Whether `path` is `parent` or sits under it, compared with case folded so a differently-cased spelling of
 * an ancestor does not read as a different tree on a case-insensitive filesystem.
 */
function within(path: string, parent: string): boolean {
	return folded(path) === folded(parent) || folded(path).startsWith(`${folded(parent)}${sep}`);
}

/**
 * @throws WorktreeError `"stale-directory"` unless `path` is exactly the worktree this would have made: its
 * own root, in this repository, on this branch.
 *
 * Asserted positively, and this is the point rather than a detail. Three review rounds each found another
 * way a worktree's `.git` file can be edited to point somewhere else — deleted, aimed at the primary, aimed
 * at a sibling — and each was closed by refusing that spelling, which left the next one to find. Asking git
 * what the directory *is* refuses every spelling at once, including ones nobody has thought of, because
 * anything that is not this worktree fails the comparison rather than having to be recognised.
 *
 * Both answers are load-bearing: a deleted link makes git report the *primary's* root, while a link aimed at
 * the primary or at a sibling keeps the root and changes the branch. The repository itself is not re-asked —
 * the registration came from this repository's own `worktree list`, so git has already said the path is ours.
 *
 * @throws WorktreeError `"git"` where git could not answer.
 */
function refuseUnlessOurs(runner: Runner, path: string, branch: string): void {
	const result = runner([...worktreeIdentityCommand(path)]);
	// The ref is the last line and cannot contain a newline; the path is everything before it and may.
	const lines = result.stdout.replace(/\n$/, "").split("\n");
	const head = lines.pop();
	const root = lines.join("\n");
	if (result.code !== 0 || head === undefined || root === "") {
		throw new WorktreeError(
			`${path} is registered as a worktree but git could not say what it is: ${gitFailure(result.stderr, result.code)}`,
			"git",
		);
	}
	if (root !== path || head !== `${REF_HEADS}${branch}`) {
		throw new WorktreeError(
			`${path} is registered as a worktree on ${branch} but git there reports ${head} rooted at ${root}`,
			"stale-directory",
		);
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
	switch (head.kind) {
		case "branch":
			return head.name;
		case "bare":
			return "a bare repository";
		case "detached":
			return "a detached HEAD";
		case "opaque":
			return "a head this could not read";
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
	if (refusingOnError(path, "listed", () => readdirSync(path)).length > 0) {
		throw new WorktreeError(`${path} already holds files and is not a registered worktree; move it aside`, "stale-directory");
	}
}

/**
 * What is at `path`, having refused it unless a worktree could be there: absent is allowed and reported
 * as `undefined`, a symlink and a non-directory are not. `complaint` says what the caller wanted it for.
 *
 * The one guard both the attach and the create route go through, so a check added here cannot hold on
 * one route and not the other.
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
	return refusingOnError(path, "inspected", () => lstatSync(path, { throwIfNoEntry: false }));
}

/**
 * Every filesystem question this guard asks, classified. `throwIfNoEntry` covers a path that is not
 * there and nothing else, so an ancestor that is a file (ENOTDIR), a directory that cannot be read
 * (EACCES), or a path that goes away mid-check all raise a plain error — which no caller catches, so
 * the command dies rather than reporting the refusal this documents. One wrapper rather than a
 * try/catch per call site, so a filesystem question added later cannot escape unclassified.
 */
function refusingOnError<T>(path: string, verb: string, work: () => T): T {
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
function branchExists(runner: Runner, repo: string, branch: string): boolean {
	const result = runner([...refExistsCommand(repo, `refs/heads/${branch}`)]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new WorktreeError(`${repo} could not be asked whether ${branch} exists: ${gitFailure(result.stderr, result.code)}`, "git");
}

/**
 * Whether `origin` has a branch this can adopt by checking it out rather than cutting a new one.
 *
 * @throws WorktreeError `"unsupported-repository"` where more than one remote offers the name. Adopting a
 * remote-only branch leaves git to resolve the name, and git refuses to resolve an ambiguous one — so the
 * argv would fail with `fatal: invalid reference` after the guards had passed. One remote is what this
 * expects; the ambiguity is detected and refused rather than engineered around, because naming the start
 * point explicitly would commit this to picking a winner among remotes it has no basis to rank.
 *
 * @throws WorktreeError `"git"` where the repository could not answer.
 */
function adoptableFromOrigin(runner: Runner, repo: string, branch: string): boolean {
	const result = runner([...remoteBranchesCommand(repo, branch)]);
	if (result.code !== 0) {
		throw new WorktreeError(
			`${repo} could not be asked which remotes have ${branch}: ${gitFailure(result.stderr, result.code)}`,
			"git",
		);
	}
	const refs = result.stdout.split("\n").filter((line) => line.trim() !== "");
	if (refs.length > 1) {
		throw new WorktreeError(
			`${branch} is on more than one remote (${refs.join(", ")}), and this expects only origin`,
			"unsupported-repository",
		);
	}
	const only = refs[0]?.trim() ?? "";
	if (!only.startsWith(REMOTES)) return false;
	const rest = only.slice(REMOTES.length);
	const slash = rest.indexOf("/");
	// The remote's name is whatever it is called on disk and git records it verbatim, so a remote named
	// `Origin` is still the one meant; the branch is compared exactly, because git branch names are
	// case-sensitive.
	return slash !== -1 && folded(rest.slice(0, slash)) === "origin" && rest.slice(slash + 1) === branch;
}

/**
 * `path`, which must be absolute, with the symlinks along it resolved — the spelling git registers a
 * worktree under. ADR-0041 has why that is computed rather than refused, why the worktree's own leaf is
 * still refused, and the measurements behind both paragraphs below.
 *
 * Do not replace this with one `realpathSync` call over the whole path. Bun resolves `<link>/..` to the
 * link's own parent, where `realpath(3)` and `git worktree add` both name the target's parent, and Bun's
 * `realpathSync.native` agrees with Bun rather than with git — so there is no escape hatch in the API.
 * Fed one segment at a time, `realpathSync` never sees a `..` and the two agree.
 *
 * A segment that is not there is appended and the walk continues, rather than the remainder being taken
 * as written: a `..` can cancel that segment out and hand a symlink back to a walk that then has to
 * resolve it. git does the same.
 */
function canonical(path: string): string {
	let at: string = sep;
	for (const segment of path.split(sep)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			at = dirname(at);
			continue;
		}
		const candidate = join(at, segment);
		at = resolved(candidate) ?? candidate;
	}
	return at;
}

/**
 * `path` resolved, or `undefined` where nothing is there at all.
 *
 * `realpathSync` raises `ENOENT` for a segment that does not exist yet — the ordinary case, since the root
 * is usually what this run creates — and for a symlink to nothing, which is a refusal. Neither is told from
 * the other by catching that, so the two are separated before it is called: `lstat` sees a link to nothing
 * where `stat` does not, and nothing at all where neither does.
 *
 * @throws WorktreeError `"stale-directory"` for a link to nothing, and for every other answer the
 * filesystem gives, `refusingOnError` classifying those.
 */
function resolved(path: string): string | undefined {
	if (inspect(path) === undefined) return undefined;
	if (refusingOnError(path, "resolved", () => statSync(path, { throwIfNoEntry: false })) === undefined) {
		throw new WorktreeError(`${path} is a symlink to nothing, so no worktree can be reached through it`, "stale-directory");
	}
	return refusingOnError(path, "resolved", () => realpathSync(path));
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

	// Checked rather than assumed — `defaultBranchCommand` has the shapes this can answer with.
	const said = result.stdout.trim();
	if (!said.startsWith(REMOTE_HEAD) || said === REMOTE_HEAD) {
		return [`${primary} named ${said === "" ? "nothing" : said} as its default branch, which is not a branch on origin`];
	}

	const target = said.slice(REMOTE_HEAD.length);
	// `symbolic-ref` reports a dangling symref without complaint, so the name it gives is not evidence the
	// ref exists. Unchecked, a dangling `origin/HEAD` whose target happened to be spelled like the primary's
	// branch compared equal and warned about nothing — the one case this warning exists to report.
	if (runner([...refExistsCommand(primary, said)]).code !== 0) {
		return [
			`which branch is the default could not be read from ${primary}: ${said} is named by origin/HEAD but is not there; set it with "git remote set-head origin --auto"`,
		];
	}
	if (target === head.name) return [];
	return [`the primary checkout ${primary} is on ${head.name}, not on ${target}`];
}

const REMOTES = "refs/remotes/";
const REMOTE_HEAD = `${REMOTES}origin/`;

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
