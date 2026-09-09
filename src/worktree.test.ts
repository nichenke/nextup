import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, defaultRunner } from "./runner";
import type { Ticket } from "./ticket";
import type { TicketRef } from "./ticket-ref";
import { DEFAULT_WORKTREE_ROOT, WorktreeError, branchName, ensure, parseWorktreeList } from "./worktree";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	// Real, because git reports worktree paths with their symlinks resolved and every path here is
	// compared against one git reported; macOS hands `mkdtemp` a symlinked path.
	return realpathSync(root);
}

type Subject = Pick<Ticket, "ref" | "title" | "labels">;

const github: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "8" };

function ticket(over: Partial<Subject> = {}): Subject {
	return { ref: github, title: "Worktree ensure and branch naming", labels: [], ...over };
}

/** The ticket the `ensure` cases use, whose branch is short enough to read in a path. */
const READER = ticket({ title: "Reader" });
const READER_BRANCH = "feature/reader-8";
const READER_LEAF = "reader-8";

describe("branchName", () => {
	test("prefixes with feature, slugs the title, and puts the key last", () => {
		expect(branchName(ticket())).toBe("feature/worktree-ensure-and-branch-naming-8");
	});

	test("prefixes with fix when the ticket carries a bug label, whatever case it is written in", () => {
		expect(branchName(ticket({ labels: ["Bug"] }))).toBe("fix/worktree-ensure-and-branch-naming-8");
	});

	test("leaves a ticket carrying other labels a feature", () => {
		expect(branchName(ticket({ labels: ["ready-for-agent", "enhancement"] }))).toBe(
			"feature/worktree-ensure-and-branch-naming-8",
		);
	});

	test("lowercases a key carrying letters rather than leaving a branch half shouted", () => {
		const jira: TicketRef = { tracker: "jira", repo: null, host: null, key: "ABC-7" };
		expect(branchName(ticket({ ref: jira }))).toBe("feature/worktree-ensure-and-branch-naming-abc-7");
	});

	test("collapses punctuation and separators rather than carrying them into a ref name", () => {
		expect(branchName(ticket({ title: "08 — Fix: the reader's *broken* path?" }))).toBe(
			"feature/08-fix-the-reader-s-broken-path-8",
		);
	});

	test("falls back to the key alone where a title has nothing a branch name can carry", () => {
		expect(branchName(ticket({ title: "—— ?? ——" }))).toBe("feature/8");
	});

	test("cuts a long title at a separator rather than mid-word, and never trails one", () => {
		const long = "A very long ticket title that runs well past what any path ought to carry";
		const name = branchName(ticket({ title: long }));
		expect(name).toBe("feature/a-very-long-ticket-title-that-runs-well-past-8");
		expect(name).not.toContain("--");
	});

	test("refuses a key a branch name cannot spell, rather than letting two tickets share one branch", () => {
		const cyrillic: TicketRef = { tracker: "jira", repo: null, host: null, key: "ЖУК-7" };
		const other: TicketRef = { tracker: "jira", repo: null, host: null, key: "ЛИС-7" };

		expect(kindOf(() => branchName(ticket({ ref: cyrillic })))).toBe("unnameable-ticket");
		expect(kindOf(() => branchName(ticket({ ref: other })))).toBe("unnameable-ticket");
	});

	test("refuses a ticket with no key, which would name a branch git will not accept", () => {
		const keyless: TicketRef = { tracker: "jira", repo: null, host: null, key: "" };

		expect(kindOf(() => branchName({ ref: keyless, title: "—— ?? ——", labels: [] }))).toBe("unnameable-ticket");
		expect(kindOf(() => branchName(ticket({ ref: keyless })))).toBe("unnameable-ticket");
	});

	test("names only branches git accepts, across every title shape the slug has to survive", () => {
		const repo = realRepo();
		const titles = ["Reader", "—— ?? ——", "08 — Fix: the reader's *broken* path?", "a".repeat(200), "...", "-", "x.lock", "_", "a__b", "_lead", "trail_"];

		for (const title of titles) {
			const name = branchName(ticket({ title }));
			expect(defaultRunner(["git", "-C", repo, "check-ref-format", "--branch", name]).code).toBe(0);
		}
	});

	test("keeps a key longer than the title limit whole, rather than refusing it as unspellable", () => {
		const long = "a".repeat(60);
		const ref: TicketRef = { tracker: "jira", repo: null, host: null, key: long };

		expect(branchName(ticket({ ref }))).toBe(`feature/worktree-ensure-and-branch-naming-${long}`);
	});

	test("keeps an underscore, which git accepts and dropping refused keys for no reason", () => {
		const ref: TicketRef = { tracker: "jira", repo: null, host: null, key: "PROJ_12" };

		expect(branchName(ticket({ ref, title: "Reader" }))).toBe("feature/reader-proj_12");
	});

	test("lets a key through whose only change is case, which is every real tracker key", () => {
		for (const key of ["8", "123", "ABC-7", "abc-7", "PROJ-1234", "PROJ_12", "A_B_C-9"]) {
			const ref: TicketRef = { tracker: "jira", repo: null, host: null, key };
			expect(() => branchName(ticket({ ref }))).not.toThrow();
		}
	});
});

/** One `--porcelain -z` record, in the layout `parseWorktreeList` documents. */
function record(attributes: readonly string[]): string {
	return `${attributes.map((one) => `${one}\0`).join("")}\0`;
}

interface GitState {
	/** Registered worktrees, primary first, as porcelain attribute lists. */
	readonly worktrees: readonly (readonly string[])[];
	readonly branches?: readonly string[];
	/** Branches on `origin` only, which must be checked out rather than created. */
	readonly remoteBranches?: readonly string[];
	/** Further remotes carrying `remoteBranches`, which makes the name ambiguous to git. */
	readonly alsoOnRemotes?: readonly string[];
	/** What the canonical remote is called on disk, which git records verbatim. */
	readonly originName?: string;
	/** `null` where `origin/HEAD` is not set, which is what a repo with no remote reports. */
	readonly defaultBranch?: string | null;
	/** Overrides the git directory, for the layouts `refuseUnlessOrdinaryLayout` turns away. */
	readonly commonDir?: string;
}

/** Where an ordinary repository keeps its administration: `<primary>/.git`, or the primary when bare. */
function ordinaryCommonDir(state: GitState): string {
	const attributes = state.worktrees[0] ?? [];
	const main = parseWorktreeList(record(attributes))[0];
	if (main === undefined) return "";
	return main.head.kind === "bare" ? main.path : join(main.path, ".git");
}

/** A git that answers from `state`, and records every argv it was asked for. */
function stubGit(state: GitState): { runner: Runner; issued: string[][] } {
	const issued: string[][] = [];
	const runner: Runner = (argv) => {
		issued.push([...argv]);
		const words = argv.join(" ");
		if (words.includes("worktree list")) {
			return { code: 0, stdout: state.worktrees.map(record).join(""), stderr: "" };
		}
		if (words.includes("symbolic-ref")) {
			const target = state.defaultBranch === undefined ? "main" : state.defaultBranch;
			return target === null
				? { code: 128, stdout: "", stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref" }
				: { code: 0, stdout: `refs/remotes/origin/${target}\n`, stderr: "" };
		}
		if (words.includes("show-ref")) {
			const ref = argv[argv.length - 1]!.slice("refs/heads/".length);
			return { code: (state.branches ?? []).includes(ref) ? 0 : 1, stdout: "", stderr: "" };
		}
		if (words.includes("for-each-ref")) {
			const branch = argv[argv.length - 1]!.slice("refs/remotes/*/".length);
			const remotes = (state.remoteBranches ?? []).includes(branch)
				? [state.originName ?? "origin", ...(state.alsoOnRemotes ?? [])]
				: [];
			return { code: 0, stdout: remotes.map((one) => `refs/remotes/${one}/${branch}\n`).join(""), stderr: "" };
		}
		if (words.includes("rev-parse")) {
			return { code: 0, stdout: `${state.commonDir ?? ordinaryCommonDir(state)}\n`, stderr: "" };
		}
		if (words.includes("worktree add")) return { code: 0, stdout: "", stderr: "" };
		throw new Error(`the worktree step asked git something unexpected: ${words}`);
	};
	return { runner, issued };
}

/** A primary checkout on the default branch, at a real directory so path checks have one to read. */
function primaryOn(branch = "main"): { repo: string; state: GitState } {
	const repo = tempDir("nextup-worktree-");
	return { repo, state: { worktrees: [[`worktree ${repo}`, "HEAD abc", `branch refs/heads/${branch}`]] } };
}

describe("ensure", () => {
	test("cuts a new branch where neither the branch nor a worktree for it exists", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.kind).toBe("created");
		expect(outcome.path).toBe(join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF));
		expect(outcome.command).toEqual(["git", "-C", repo, "worktree", "add", outcome.path, "-b", READER_BRANCH]);
		expect(git.issued[git.issued.length - 1]).toEqual(outcome.command === null ? [] : [...outcome.command]);
		expect(outcome.warnings).toEqual([]);
	});

	test("checks out a branch that already exists rather than asking git to create it again", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, branches: [READER_BRANCH] });
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.kind).toBe("checked-out");
		expect(outcome.command).toEqual(["git", "-C", repo, "worktree", "add", outcome.path, READER_BRANCH]);
	});

	test("checks out a branch that exists only on origin, rather than cutting a new one over it", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, remoteBranches: [READER_BRANCH] });
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.kind).toBe("checked-out");
		expect(outcome.command).not.toContain("-b");
	});

	test("refuses a branch offered by more than one remote rather than leaving git to guess", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, remoteBranches: [READER_BRANCH], alsoOnRemotes: ["up"] });

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("unsupported-repository");
		expect(git.issued.some((argv) => argv.includes("add"))).toBe(false);
	});

	test("attaches to the worktree already at the expected path, issuing nothing", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", `branch refs/heads/${READER_BRANCH}`]],
			branches: [READER_BRANCH],
		});
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.kind).toBe("attached");
		expect(outcome.path).toBe(path);
		expect(outcome.command).toBeNull();
		expect(git.issued.some((argv) => argv.includes("add"))).toBe(false);
	});

	test("refuses a branch checked out at another path rather than adding a second worktree for it", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, ["worktree /somewhere/else", "HEAD abc", `branch refs/heads/${READER_BRANCH}`]],
			branches: [READER_BRANCH],
		});

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/already checked out at \/somewhere\/else/);
		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("branch-elsewhere");
	});

	test("says the directory is gone when the branch is registered to one that has been removed", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({
			...state,
			worktrees: [
				...state.worktrees,
				["worktree /somewhere/else", "HEAD abc", `branch refs/heads/${READER_BRANCH}`, "prunable gitdir file"],
			],
		});

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/a directory that is not there/);
	});

	test("refuses a stale directory holding files at the path the worktree goes", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "leftover"), "half a checkout\n");
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("proceeds through an empty directory at the path, which git itself accepts", () => {
		const { repo, state } = primaryOn();
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF), { recursive: true });
		const git = stubGit(state);

		expect(ensure({ runner: git.runner, repo, ticket: READER }).kind).toBe("created");
	});

	test("refuses a file sitting where the worktree goes", () => {
		const { repo, state } = primaryOn();
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		writeFileSync(join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF), "not a directory\n");
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("refuses a registration at the expected path whose directory is gone, naming the cure", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		const git = stubGit({
			...state,
			worktrees: [
				...state.worktrees,
				[`worktree ${path}`, "HEAD abc", `branch refs/heads/${READER_BRANCH}`, "prunable gitdir file"],
			],
		});

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/git worktree prune/);
	});

	test("refuses a worktree at the expected path that is on another branch", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", "branch refs/heads/feature/something-else"]],
		});

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/already a worktree on feature\/something-else/);
	});

	test("refuses a worktree at the expected path that is on a detached HEAD", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		const git = stubGit({ ...state, worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", "detached"]] });

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/a detached HEAD/);
	});

	test("warns when the primary checkout has drifted off the default branch, and still creates", () => {
		const { repo, state } = primaryOn("feature/something-half-done");
		const git = stubGit(state);
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.kind).toBe("created");
		expect(outcome.warnings).toEqual([`the primary checkout ${repo} is on feature/something-half-done, not on main`]);
	});

	test("warns when the primary checkout is detached, which no default branch comparison would catch", () => {
		const repo = tempDir("nextup-worktree-");
		const git = stubGit({ worktrees: [[`worktree ${repo}`, "HEAD abc", "detached"]] });
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.warnings).toEqual([`the primary checkout ${repo} is on a detached HEAD`]);
	});

	test("says so when there is no default branch to check against, rather than dropping the check", () => {
		const { repo, state } = primaryOn("some-branch");
		const git = stubGit({ ...state, defaultBranch: null });
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.warnings[0]).toContain("could not be read");
		expect(outcome.warnings[0]).toContain("git remote set-head origin --auto");
	});

	test("says so when origin/HEAD names something that is not a branch on origin", () => {
		const { repo, state } = primaryOn("main");
		const git = stubGit(state);
		const local: Runner = (argv) =>
			argv.includes("symbolic-ref") ? { code: 0, stdout: "refs/heads/main\n", stderr: "" } : git.runner(argv);

		const warnings = ensure({ runner: local, repo, ticket: READER }).warnings;
		expect(warnings).toEqual([`${repo} named refs/heads/main as its default branch, which is not a branch on origin`]);
	});

	test("compares against whatever origin/HEAD names, not against a branch called main", () => {
		const { repo, state } = primaryOn("trunk");
		const git = stubGit({ ...state, defaultBranch: "trunk" });

		expect(ensure({ runner: git.runner, repo, ticket: READER }).warnings).toEqual([]);
	});

	test("puts the worktree under an absolute root as given, so another launcher can site it elsewhere", () => {
		const { repo, state } = primaryOn();
		const elsewhere = tempDir("nextup-elsewhere-");
		const git = stubGit(state);
		const outcome = ensure({ runner: git.runner, repo, ticket: READER, root: elsewhere });

		expect(outcome.path).toBe(join(elsewhere, READER_LEAF));
	});

	test("resolves a relative root against the primary checkout, not the checkout it was invoked in", () => {
		const { repo, state } = primaryOn();
		const invokedIn = join(repo, DEFAULT_WORKTREE_ROOT, "some-other-worktree");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${invokedIn}`, "HEAD abc", "branch refs/heads/feature/other-3"]],
		});
		const outcome = ensure({ runner: git.runner, repo: invokedIn, ticket: READER, root: "trees" });

		expect(outcome.path).toBe(join(repo, "trees", READER_LEAF));
		expect(outcome.primary).toBe(repo);
	});

	test("asks git from the directory it was given, and cuts the branch from the primary checkout", () => {
		const { repo, state } = primaryOn();
		const invokedIn = join(repo, DEFAULT_WORKTREE_ROOT, "some-other-worktree");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${invokedIn}`, "HEAD abc", "branch refs/heads/feature/other-3"]],
		});
		const outcome = ensure({ runner: git.runner, repo: invokedIn, ticket: READER });

		expect(git.issued[0]).toEqual(["git", "-C", invokedIn, "worktree", "list", "--porcelain", "-z"]);
		expect(outcome.command).toContain(repo);
	});

	test("says a bare primary is bare, rather than reporting a checkout it does not have", () => {
		const repo = tempDir("nextup-worktree-");
		const git = stubGit({ worktrees: [[`worktree ${repo}`, "bare"]] });
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });

		expect(outcome.warnings).toEqual([
			`${repo} is a bare repository, so it has no checkout to compare against a default branch`,
		]);
		expect(git.issued.some((argv) => argv.includes("symbolic-ref"))).toBe(false);
	});

	test("says so when it cannot tell what the primary is on, rather than picking one of the three", () => {
		const repo = tempDir("nextup-worktree-");
		const git = stubGit({ worktrees: [[`worktree ${repo}`, "HEAD abc"]] });

		expect(ensure({ runner: git.runner, repo, ticket: READER }).warnings).toEqual([
			`the primary checkout ${repo} is on a head this could not read`,
		]);
	});

	test("refuses a directory it cannot list, rather than letting the listing error escape", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		chmodSync(path, 0o000);
		const git = stubGit(state);

		try {
			expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
		} finally {
			chmodSync(path, 0o755);
		}
	});

	test("refuses a dangling symlink at the path, which following the link would have read as nothing", () => {
		const { repo, state } = primaryOn();
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		symlinkSync(join(repo, "gone"), join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF));
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("refuses a symlink where the worktree goes, whatever is behind it", () => {
		const { repo, state } = primaryOn();
		const real = join(repo, "somewhere-real");
		mkdirSync(real, { recursive: true });
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		symlinkSync(real, join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF));
		const git = stubGit(state);

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/is a symlink/);
	});

	test("refuses a symlink at the path when the directory behind it holds files", () => {
		const { repo, state } = primaryOn();
		const real = join(repo, "somewhere-real");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "leftover"), "half a checkout\n");
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		symlinkSync(real, join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF));
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("refuses when the repository cannot say whether the branch exists, rather than assuming it does not", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const failing: Runner = (argv) =>
			argv.includes("show-ref")
				? { code: 128, stdout: "", stderr: "fatal: unexpected line in .git/packed-refs" }
				: git.runner(argv);

		expect(kindOf(() => ensure({ runner: failing, repo, ticket: READER }))).toBe("git");
	});

	test("refuses when the path cannot be inspected at all, rather than letting the error escape", () => {
		const { repo, state } = primaryOn();
		// An ancestor that is a file, which `lstat` answers with ENOTDIR rather than "nothing there".
		writeFileSync(join(repo, DEFAULT_WORKTREE_ROOT), "a placeholder, not a directory\n");
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("takes an absolute root as written, however it was spelled", () => {
		const { repo, state } = primaryOn();
		const elsewhere = tempDir("nextup-elsewhere-");
		const git = stubGit(state);

		for (const spelling of [elsewhere, `${elsewhere}/`, `${elsewhere}/./`, `${elsewhere}/sub/..`]) {
			expect(ensure({ runner: git.runner, repo, ticket: READER, root: spelling }).path).toBe(join(elsewhere, READER_LEAF));
		}
	});

	test("refuses a repository whose git directory is somewhere other than the primary's own .git", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, commonDir: join(tempDir("nextup-elsewhere-"), "elsewhere") });

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER }))).toBe("unsupported-repository");
	});

	test("refuses before touching the filesystem, since the root it would compute is the git directory", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, commonDir: join(tempDir("nextup-elsewhere-"), "elsewhere") });

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow();
		expect(git.issued.some((argv) => argv.includes("add"))).toBe(false);
	});

	test("reports a repository that cannot say where its git directory is as a git failure", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const failing: Runner = (argv) =>
			argv.includes("rev-parse") ? { code: 128, stdout: "", stderr: "fatal: not a git repository" } : git.runner(argv);

		expect(kindOf(() => ensure({ runner: failing, repo, ticket: READER }))).toBe("git");
	});

	test("reads an empty answer about the git directory as a git failure, not as an unsupported layout", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const silent: Runner = (argv) => (argv.includes("rev-parse") ? { code: 0, stdout: "", stderr: "" } : git.runner(argv));

		// Exit 0 saying nothing is what `WorktreeError`'s `"git"` covers. Matched against neither accepted
		// shape it would otherwise report a layout refusal naming no directory at all.
		expect(kindOf(() => ensure({ runner: silent, repo, ticket: READER }))).toBe("git");
	});

	test("refuses a root naming the primary checkout however it is cased", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER, root: repo.toUpperCase() }))).toBe(
			"stale-directory",
		);
	});

	test("refuses a root reaching the git directory however it is cased", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		for (const root of [".GIT/worktrees", ".Git", join(repo, ".GIT", "trees")]) {
			expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER, root }))).toBe("stale-directory");
		}
	});

	test("adopts origin's branch whatever case the remote is named", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, remoteBranches: [READER_BRANCH], originName: "Origin" });

		// Cutting a new branch here would leave every commit already pushed to that remote behind, which is
		// what asking the remotes at all is for.
		const outcome = ensure({ runner: git.runner, repo, ticket: READER });
		expect(outcome.kind).toBe("checked-out");
		expect(outcome.command).not.toContain("-b");
	});

	test("refuses a root naming the primary checkout, where worktrees would sit unignored beside its own files", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		for (const root of [".", repo, `${repo}/`]) {
			expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER, root }))).toBe("stale-directory");
		}
	});

	test("takes the default for a root that is absent or blank, rather than resolving blank to the checkout", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		for (const root of [undefined, null, "", "   ", "\t"]) {
			expect(ensure({ runner: git.runner, repo, ticket: READER, root }).path).toBe(
				join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF),
			);
		}
	});

	test("refuses a root inside the git directory, whose own files a session would see as untracked", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		for (const root of [".git", ".git/worktrees", join(repo, ".git")]) {
			expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER, root }))).toBe("stale-directory");
		}
	});

	test("takes a root inside the checkout as given, which is the caller's business rather than a refusal", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);

		expect(ensure({ runner: git.runner, repo, ticket: READER, root: "src" }).path).toBe(join(repo, "src", READER_LEAF));
	});

	test("refuses a root reached through a dangling symlink, which resolves to nothing to compare", () => {
		const { repo, state } = primaryOn();
		symlinkSync(join(repo, "never-created"), join(repo, "dangling"));
		const git = stubGit(state);

		expect(kindOf(() => ensure({ runner: git.runner, repo, ticket: READER, root: join(repo, "dangling") }))).toBe(
			"stale-directory",
		);
	});

	test("refuses to attach where the registered path is no longer a directory", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		writeFileSync(path, "a file where the worktree used to be\n");
		const git = stubGit({
			...state,
			worktrees: [
				...state.worktrees,
				[`worktree ${path}`, "HEAD abc", `branch refs/heads/${READER_BRANCH}`, "locked keep"],
			],
		});

		// Something is there, so `gone` is false, and the lock keeps git from saying prunable.
		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/not a directory/);
	});

	test("applies the symlink refusal to an attach too, not only to a worktree it is about to make", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		const moved = join(repo, "moved-away");
		mkdirSync(moved, { recursive: true });
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		symlinkSync(moved, path);
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", `branch refs/heads/${READER_BRANCH}`]],
		});

		expect(() => ensure({ runner: git.runner, repo, ticket: READER })).toThrow(/is a symlink/);
	});

	test("reports a git that will not answer as a git failure rather than as a missing worktree", () => {
		const runner: Runner = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });

		expect(kindOf(() => ensure({ runner, repo: "/nowhere", ticket: READER }))).toBe("git");
	});

	test("refuses a directory that answers about worktrees without listing one", () => {
		const runner: Runner = () => ({ code: 0, stdout: "", stderr: "" });

		expect(() => ensure({ runner, repo: "/nowhere", ticket: READER })).toThrow(/not a git checkout/);
	});

	test("refuses a ticket that cannot name a branch before asking git anything", () => {
		const cyrillic: TicketRef = { tracker: "jira", repo: null, host: null, key: "ЖУК-7" };
		const runner: Runner = (argv) => {
			throw new Error(`nothing should run: ${argv.join(" ")}`);
		};

		expect(kindOf(() => ensure({ runner, repo: "/nowhere", ticket: ticket({ ref: cyrillic }) }))).toBe("unnameable-ticket");
	});

	test("reports what git said when the add fails, rather than a bare exit status", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const failing: Runner = (argv) =>
			argv.includes("add") ? { code: 128, stdout: "", stderr: "fatal: could not create work tree\n" } : git.runner(argv);

		expect(() => ensure({ runner: failing, repo, ticket: READER })).toThrow(/could not create work tree/);
	});

	test("falls back to the exit status where git failed without saying anything", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const silent: Runner = (argv) => (argv.includes("add") ? { code: 3, stdout: "", stderr: "" } : git.runner(argv));

		expect(kindOf(() => ensure({ runner: silent, repo, ticket: READER }))).toBe("git");
		expect(() => ensure({ runner: silent, repo, ticket: READER })).toThrow(/git exited 3/);
	});
});

describe("parseWorktreeList", () => {
	test("reads a path containing a newline as the path, which the line form cannot", () => {
		const odd = "/tmp/a\nb";
		const parsed = parseWorktreeList(record([`worktree ${odd}`, "HEAD abc", "branch refs/heads/main"]));

		expect(parsed).toEqual([{ path: odd, head: { kind: "branch", name: "main" }, prunable: false, locked: false }]);
	});

	test("keeps reading past an attribute it does not know", () => {
		const parsed = parseWorktreeList(
			record(["worktree /a", "HEAD abc", "something-git-learned later", "branch refs/heads/main"]),
		);

		expect(parsed).toEqual([{ path: "/a", head: { kind: "branch", name: "main" }, prunable: false, locked: false }]);
	});

	test("keeps a bare primary and a detached one apart, rather than as two absent branches", () => {
		expect(parseWorktreeList(record(["worktree /a", "bare"]))).toEqual([
			{ path: "/a", head: { kind: "bare" }, prunable: false, locked: false },
		]);
		expect(parseWorktreeList(record(["worktree /b", "HEAD abc", "detached"]))).toEqual([
			{ path: "/b", head: { kind: "detached" }, prunable: false, locked: false },
		]);
	});

	test("calls a record naming no head at all opaque, rather than reading it as any of the three", () => {
		expect(parseWorktreeList(record(["worktree /a", "HEAD abc"]))).toEqual([
			{ path: "/a", head: { kind: "opaque" }, prunable: false, locked: false },
		]);
	});
});

/** A real repository with one commit, on `main`, and `origin/HEAD` pointed at it. */
function realRepo(): string {
	const root = tempDir("nextup-real-git-");
	const git = (...argv: string[]): void => {
		const result = defaultRunner(["git", "-C", root, ...argv]);
		if (result.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
	};
	git("init", "--quiet", "--initial-branch", "main");
	git("-c", "user.email=nobody@invalid", "-c", "user.name=nobody", "commit", "--quiet", "--allow-empty", "-m", "init");
	git("remote", "add", "origin", root);
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	return realpathSync(root);
}

/**
 * Against real git rather than a stub, because every refusal here exists for a porcelain behaviour —
 * which directories `git worktree add` accepts, what it does with a branch already checked out
 * somewhere — and a stub asserting those asserts only what this file believes about them.
 */
describe("ensure against real git", () => {
	test("creates the branch and the worktree, and a second run attaches to what the first made", () => {
		const repo = realRepo();
		const first = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(first.kind).toBe("created");

		const second = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(second.kind).toBe("attached");
		expect(second.path).toBe(first.path);
	});

	test("attaches to a worktree git was told to make by hand, not only to one of its own", () => {
		const repo = realRepo();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		expect(defaultRunner(["git", "-C", repo, "worktree", "add", path, "-b", READER_BRANCH]).code).toBe(0);

		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(outcome.kind).toBe("attached");
		expect(outcome.path).toBe(path);
	});

	test("checks out a branch that exists without a worktree, where creating it would be fatal", () => {
		const repo = realRepo();
		expect(defaultRunner(["git", "-C", repo, "branch", READER_BRANCH]).code).toBe(0);

		expect(ensure({ runner: defaultRunner, repo, ticket: READER }).kind).toBe("checked-out");
	});

	test("refuses when a relabelled ticket wants the path its own earlier branch holds", () => {
		const repo = realRepo();
		expect(ensure({ runner: defaultRunner, repo, ticket: READER }).branch).toBe(READER_BRANCH);

		// Only the last component of the branch names the directory, so labelling the ticket a bug moves it
		// from `feature/` to `fix/` while leaving the path unchanged.
		expect(() => ensure({ runner: defaultRunner, repo, ticket: ticket({ title: "Reader", labels: ["bug"] }) })).toThrow(
			new RegExp(`already a worktree on ${READER_BRANCH}, not on fix/reader-8`),
		);
	});

	test("lands on the pushed tip when the branch survives only on origin, not on the primary's HEAD", () => {
		const repo = realRepo();
		const remote = join(tempDir("nextup-remote-"), "remote.git");
		const git = (...argv: string[]): string => {
			const result = defaultRunner(["git", "-C", repo, ...argv]);
			if (result.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
			return result.stdout.trim();
		};
		expect(defaultRunner(["git", "init", "--quiet", "--bare", remote]).code).toBe(0);
		git("remote", "set-url", "origin", remote);
		git("checkout", "--quiet", "-b", READER_BRANCH);
		git("-c", "user.email=nobody@invalid", "-c", "user.name=nobody", "commit", "--quiet", "--allow-empty", "-m", "pushed");
		const pushed = git("rev-parse", "HEAD");
		git("push", "--quiet", "origin", READER_BRANCH);
		git("checkout", "--quiet", "main");
		git("branch", "-D", READER_BRANCH);
		git("fetch", "--quiet", "origin");

		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });

		expect(outcome.kind).toBe("checked-out");
		expect(defaultRunner(["git", "-C", outcome.path, "rev-parse", "HEAD"]).stdout.trim()).toBe(pushed);
		expect(git("config", "--get", `branch.${READER_BRANCH}.remote`)).toBe("origin");
	});

	test("refuses when two real remotes offer the branch, which git itself will not resolve", () => {
		const repo = realRepo();
		const outer = tempDir("nextup-two-remotes-");
		const identity = ["-c", "user.email=nobody@invalid", "-c", "user.name=nobody"];
		const git = (...argv: string[]): void => {
			const result = defaultRunner(["git", "-C", repo, ...argv]);
			if (result.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
		};
		for (const name of ["origin", "up"]) {
			expect(defaultRunner(["git", "init", "--quiet", "--bare", join(outer, `${name}.git`)]).code).toBe(0);
		}
		git("remote", "set-url", "origin", join(outer, "origin.git"));
		git("remote", "add", "up", join(outer, "up.git"));
		git("checkout", "--quiet", "-b", READER_BRANCH);
		git(...identity, "commit", "--quiet", "--allow-empty", "-m", "pushed");
		for (const name of ["origin", "up"]) git("push", "--quiet", name, READER_BRANCH);
		git("checkout", "--quiet", "main");
		git("branch", "-D", READER_BRANCH);
		git("fetch", "--quiet", "--all");

		// git resolves a remote-only branch by guessing and will not guess between two remotes: the argv this
		// would otherwise issue dies on `fatal: invalid reference`. Asserted, so the refusal is not theoretical.
		expect(defaultRunner(["git", "-C", repo, "worktree", "add", join(outer, "guess"), READER_BRANCH]).stderr).toContain(
			"invalid reference",
		);
		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER }))).toBe("unsupported-repository");
	});

	test("refuses a branch git has already handed to another worktree", () => {
		const repo = realRepo();
		const elsewhere = join(tempDir("nextup-elsewhere-"), "held");
		expect(defaultRunner(["git", "-C", repo, "worktree", "add", elsewhere, "-b", READER_BRANCH]).code).toBe(0);

		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER }))).toBe("branch-elsewhere");
	});

	test("refuses a stale directory where git would report a bare fatal", () => {
		const repo = realRepo();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, READER_LEAF);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "leftover"), "half a checkout\n");

		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("refuses the registration left behind when a worktree directory is deleted by hand", () => {
		const repo = realRepo();
		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });
		rmSync(outcome.path, { recursive: true, force: true });

		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER }))).toBe("stale-directory");
	});

	test("refuses a root under the git directory, which real git will otherwise happily create", () => {
		const repo = realRepo();

		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER, root: ".git/worktrees" }))).toBe(
			"stale-directory",
		);

		// git itself accepts this, so the refusal is ours alone — hence asserting what git does, not ours.
		const path = join(repo, ".git", "worktrees", READER_LEAF);
		expect(defaultRunner(["git", "-C", repo, "worktree", "add", path, "-b", READER_BRANCH]).code).toBe(0);
		const untracked = defaultRunner(["git", "-C", path, "status", "--short"]).stdout;
		expect(untracked).toContain("?? HEAD");
		expect(untracked).toContain("?? index");
	});

	test("refuses a worktree root reached through a symlink rather than resolving it", () => {
		const repo = realRepo();
		const real = join(tempDir("nextup-linked-root-"), "trees");
		mkdirSync(real, { recursive: true });
		const linked = join(repo, "trees-by-link");
		symlinkSync(real, linked);

		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER, root: linked }))).toBe("stale-directory");
	});

	test("refuses an absolute root whose ancestor is a symlink, not only one that is a symlink itself", () => {
		const repo = realRepo();
		const outer = tempDir("nextup-linked-ancestor-");
		mkdirSync(join(outer, "real"), { recursive: true });
		symlinkSync(join(outer, "real"), join(outer, "link"));

		// The shape that makes every absolute root under a macOS `/tmp`, `/var` or `$TMPDIR` unusable: the
		// container is not itself a link and need not exist, but an ancestor is. Pins what the walk does
		// today, which nichenke/nextup issue 39 is deciding — a narrower guard would let this through.
		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER, root: join(outer, "link", "trees") }))).toBe(
			"stale-directory",
		);
	});

	test("refuses a locked registration whose directory is gone, which git never calls prunable", () => {
		const repo = realRepo();
		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(defaultRunner(["git", "-C", repo, "worktree", "lock", "--reason", "keep", outcome.path]).code).toBe(0);
		rmSync(outcome.path, { recursive: true, force: true });

		expect(defaultRunner(["git", "-C", repo, "worktree", "list", "--porcelain"]).stdout).not.toContain("prunable");
		expect(kindOf(() => ensure({ runner: defaultRunner, repo, ticket: READER }))).toBe("stale-directory");
		expect(() => ensure({ runner: defaultRunner, repo, ticket: READER })).toThrow(/unlock it/);
	});

	test("turns away a real --separate-git-dir repository rather than planting worktrees in its git directory", () => {
		const outer = tempDir("nextup-separate-");
		const gitDir = join(outer, "elsewhere");
		expect(defaultRunner(["git", "init", "--quiet", "--initial-branch", "main", "--separate-git-dir", gitDir, join(outer, "wt")]).code).toBe(0);
		const work = join(outer, "wt");
		expect(
			defaultRunner(["git", "-C", work, "-c", "user.email=n@invalid", "-c", "user.name=n", "commit", "--quiet", "--allow-empty", "-m", "init"]).code,
		).toBe(0);

		// Asserted because it is the premise `refuseUnlessOrdinaryLayout` rests on, not to restate it.
		expect(defaultRunner(["git", "-C", work, "worktree", "list", "--porcelain"]).stdout).toContain(gitDir);
		expect(kindOf(() => ensure({ runner: defaultRunner, repo: work, ticket: READER }))).toBe("unsupported-repository");
	});

	test("turns away a submodule, whose git directory lives under the superproject", () => {
		const outer = tempDir("nextup-submodule-");
		const identity = ["-c", "user.email=n@invalid", "-c", "user.name=n"];
		for (const name of ["child", "super"]) {
			expect(defaultRunner(["git", "init", "--quiet", "--initial-branch", "main", join(outer, name)]).code).toBe(0);
			expect(defaultRunner(["git", "-C", join(outer, name), ...identity, "commit", "--quiet", "--allow-empty", "-m", "init"]).code).toBe(0);
		}
		const superproject = join(outer, "super");
		const add = ["git", "-C", superproject, "-c", "protocol.file.allow=always", ...identity];
		expect(defaultRunner([...add, "submodule", "add", "--quiet", join(outer, "child"), "child"]).code).toBe(0);

		// Ordinary, unlike `--separate-git-dir`: a submodule's `.git` is a file too, so `worktree list` names
		// `<super>/.git/modules/child` as the primary and the default root would resolve inside it.
		expect(kindOf(() => ensure({ runner: defaultRunner, repo: join(superproject, "child"), ticket: READER }))).toBe(
			"unsupported-repository",
		);
	});

	test("does not tell a bare repository it is on a detached HEAD, which it has no checkout to be", () => {
		const bare = join(tempDir("nextup-bare-"), "bare.git");
		expect(defaultRunner(["git", "init", "--quiet", "--bare", "--initial-branch", "main", bare]).code).toBe(0);

		expect(ensure({ runner: defaultRunner, repo: bare, ticket: READER }).warnings).toEqual([
			`${realpathSync(bare)} is a bare repository, so it has no checkout to compare against a default branch`,
		]);
	});

	test("does not tell a detached primary it is on a branch, or call it bare", () => {
		const repo = realRepo();
		expect(defaultRunner(["git", "-C", repo, "checkout", "--quiet", "--detach"]).code).toBe(0);

		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(outcome.warnings).toEqual([`the primary checkout ${repo} is on a detached HEAD`]);
		expect(outcome.kind).toBe("created");
	});

	test("warns rather than refusing when the primary checkout has drifted off the default branch", () => {
		const repo = realRepo();
		expect(defaultRunner(["git", "-C", repo, "checkout", "--quiet", "-b", "wip"]).code).toBe(0);

		const outcome = ensure({ runner: defaultRunner, repo, ticket: READER });
		expect(outcome.kind).toBe("created");
		expect(outcome.warnings).toEqual([`the primary checkout ${repo} is on wip, not on main`]);
	});

	test("cuts the branch from the primary checkout rather than from the worktree it was invoked in", () => {
		const repo = realRepo();
		const other = ensure({ runner: defaultRunner, repo, ticket: ticket({ title: "Other", ref: { ...github, key: "3" } }) });
		expect(
			defaultRunner([
				"git",
				"-C",
				other.path,
				"-c",
				"user.email=nobody@invalid",
				"-c",
				"user.name=nobody",
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"only on the other branch",
			]).code,
		).toBe(0);

		ensure({ runner: defaultRunner, repo: other.path, ticket: READER });

		const merged = defaultRunner(["git", "-C", repo, "branch", "--contains", other.branch]).stdout;
		expect(merged).not.toContain(READER_BRANCH);
	});
});

function kindOf(work: () => unknown): string {
	try {
		work();
	} catch (cause) {
		if (cause instanceof WorktreeError) return cause.kind;
		throw cause;
	}
	throw new Error("expected a WorktreeError, and nothing was thrown");
}
