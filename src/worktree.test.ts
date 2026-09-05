import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, defaultRunner } from "./runner";
import type { Ticket } from "./ticket";
import type { TicketRef } from "./ticket-ref";
import {
	DEFAULT_WORKTREE_ROOT,
	WorktreeError,
	branchName,
	ensureWorktree,
	parseWorktreeList,
	planWorktree,
} from "./worktree";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

const markdown: TicketRef = { tracker: "markdown", repo: null, host: null, key: "8" };

function ticket(over: Partial<Pick<Ticket, "ref" | "title" | "labels">> = {}): Pick<Ticket, "ref" | "title" | "labels"> {
	return { ref: markdown, title: "Worktree ensure and branch naming", labels: [], ...over };
}

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

	test("gives a markdown ticket the same shape as a tracker one, its filename number last", () => {
		const gh: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "123" };
		expect(branchName(ticket({ ref: gh }))).toBe("feature/worktree-ensure-and-branch-naming-123");
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

	test("produces a name git itself accepts as a branch", () => {
		const repo = realRepo();
		const name = branchName(ticket({ title: "08 — Fix: the reader's *broken* path?" }));
		expect(defaultRunner(["git", "-C", repo, "check-ref-format", "--branch", name]).code).toBe(0);
	});
});

/** One `--porcelain -z` record: attributes NUL-terminated, the record closed by an empty one. */
function record(attributes: readonly string[]): string {
	return `${attributes.map((one) => `${one}\0`).join("")}\0`;
}

interface GitState {
	/** Registered worktrees, primary first, as porcelain attribute lists. */
	readonly worktrees: readonly (readonly string[])[];
	readonly branches?: readonly string[];
	/** `null` where `origin/HEAD` is not set, which is what a repo with no remote reports. */
	readonly defaultBranch?: string | null;
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
			const ref = argv[argv.length - 1]!.replace("refs/heads/", "");
			return { code: (state.branches ?? []).includes(ref) ? 0 : 1, stdout: "", stderr: "" };
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

describe("planWorktree", () => {
	test("cuts a new branch where neither the branch nor a worktree for it exists", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.kind).toBe("created");
		expect(plan.path).toBe(join(repo, DEFAULT_WORKTREE_ROOT, "reader-8"));
		expect(plan.command).toEqual(["git", "-C", repo, "worktree", "add", plan.path, "-b", "feature/reader-8"]);
		expect(plan.warnings).toEqual([]);
	});

	test("checks out a branch that already exists rather than asking git to create it again", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({ ...state, branches: ["feature/reader-8"] });
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.kind).toBe("checked-out");
		expect(plan.command).toEqual(["git", "-C", repo, "worktree", "add", plan.path, "feature/reader-8"]);
	});

	test("attaches to the worktree already at the expected path, issuing nothing", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", "branch refs/heads/feature/reader-8"]],
			branches: ["feature/reader-8"],
		});
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.kind).toBe("attached");
		expect(plan.path).toBe(path);
		expect(plan.command).toBeNull();
		expect(git.issued.some((argv) => argv.includes("add"))).toBe(false);
	});

	test("refuses a branch checked out at another path rather than adding a second worktree for it", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, ["worktree /somewhere/else", "HEAD abc", "branch refs/heads/feature/reader-8"]],
			branches: ["feature/reader-8"],
		});

		expect(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" })).toThrow(
			/already checked out at \/somewhere\/else/,
		);
		expect(kindOf(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" }))).toBe(
			"branch-elsewhere",
		);
	});

	test("says the directory is gone when the branch is registered to one that has been removed", () => {
		const { repo, state } = primaryOn();
		const git = stubGit({
			...state,
			worktrees: [
				...state.worktrees,
				["worktree /somewhere/else", "HEAD abc", "branch refs/heads/feature/reader-8", "prunable gitdir file"],
			],
		});

		expect(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" })).toThrow(
			/a directory that is gone/,
		);
	});

	test("refuses a stale directory holding files at the path the worktree goes", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "leftover"), "half a checkout\n");
		const git = stubGit(state);

		expect(kindOf(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" }))).toBe(
			"stale-directory",
		);
	});

	test("proceeds through an empty directory at the path, which git itself accepts", () => {
		const { repo, state } = primaryOn();
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT, "reader-8"), { recursive: true });
		const git = stubGit(state);

		expect(planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" }).kind).toBe("created");
	});

	test("refuses a file sitting where the worktree goes", () => {
		const { repo, state } = primaryOn();
		mkdirSync(join(repo, DEFAULT_WORKTREE_ROOT), { recursive: true });
		writeFileSync(join(repo, DEFAULT_WORKTREE_ROOT, "reader-8"), "not a directory\n");
		const git = stubGit(state);

		expect(kindOf(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" }))).toBe(
			"stale-directory",
		);
	});

	test("refuses a registration at the expected path whose directory is gone, naming the cure", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		const git = stubGit({
			...state,
			worktrees: [
				...state.worktrees,
				[`worktree ${path}`, "HEAD abc", "branch refs/heads/feature/reader-8", "prunable gitdir file"],
			],
		});

		expect(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" })).toThrow(
			/git worktree prune/,
		);
	});

	test("refuses a worktree at the expected path that is on another branch", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", "branch refs/heads/feature/something-else"]],
		});

		expect(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" })).toThrow(
			/already a worktree on feature\/something-else/,
		);
	});

	test("refuses a worktree at the expected path that is on a detached HEAD", () => {
		const { repo, state } = primaryOn();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${path}`, "HEAD abc", "detached"]],
		});

		expect(() => planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" })).toThrow(/a detached HEAD/);
	});

	test("warns when the primary checkout has drifted off the default branch, and still plans", () => {
		const { repo, state } = primaryOn("feature/something-half-done");
		const git = stubGit(state);
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.kind).toBe("created");
		expect(plan.warnings).toEqual([`the primary checkout ${repo} is on feature/something-half-done, not on main`]);
	});

	test("warns when the primary checkout is detached, which no default branch comparison would catch", () => {
		const repo = tempDir("nextup-worktree-");
		const git = stubGit({ worktrees: [[`worktree ${repo}`, "HEAD abc", "detached"]] });
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.warnings).toEqual([`the primary checkout ${repo} is on a detached HEAD`]);
	});

	test("says so when there is no default branch to check against, rather than dropping the check", () => {
		const { repo, state } = primaryOn("some-branch");
		const git = stubGit({ ...state, defaultBranch: null });
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });

		expect(plan.warnings[0]).toContain("could not be read");
		expect(plan.warnings[0]).toContain("git remote set-head origin --auto");
	});

	test("compares against whatever origin/HEAD names, not against a branch called main", () => {
		const { repo, state } = primaryOn("trunk");
		const git = stubGit({ ...state, defaultBranch: "trunk" });

		expect(planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" }).warnings).toEqual([]);
	});

	test("puts the worktree under an absolute root as given, so another launcher can site it elsewhere", () => {
		const { repo, state } = primaryOn();
		const elsewhere = tempDir("nextup-elsewhere-");
		const git = stubGit(state);
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8", root: elsewhere });

		expect(plan.path).toBe(join(elsewhere, "reader-8"));
	});

	test("resolves a relative root against the primary checkout, not the checkout it was invoked in", () => {
		const { repo, state } = primaryOn();
		const invokedIn = join(repo, DEFAULT_WORKTREE_ROOT, "some-other-worktree");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${invokedIn}`, "HEAD abc", "branch refs/heads/feature/other-3"]],
		});
		const plan = planWorktree({ runner: git.runner, repo: invokedIn, branch: "feature/reader-8", root: "trees" });

		expect(plan.path).toBe(join(repo, "trees", "reader-8"));
		expect(plan.primary).toBe(repo);
	});

	test("asks git from the directory it was given, and cuts the branch from the primary checkout", () => {
		const { repo, state } = primaryOn();
		const invokedIn = join(repo, DEFAULT_WORKTREE_ROOT, "some-other-worktree");
		const git = stubGit({
			...state,
			worktrees: [...state.worktrees, [`worktree ${invokedIn}`, "HEAD abc", "branch refs/heads/feature/other-3"]],
		});
		const plan = planWorktree({ runner: git.runner, repo: invokedIn, branch: "feature/reader-8" });

		expect(git.issued[0]).toEqual(["git", "-C", invokedIn, "worktree", "list", "--porcelain", "-z"]);
		expect(plan.command).toContain(repo);
	});

	test("reports a git that will not answer as a git failure rather than as a missing worktree", () => {
		const runner: Runner = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });

		expect(kindOf(() => planWorktree({ runner, repo: "/nowhere", branch: "feature/reader-8" }))).toBe("git");
	});

	test("refuses a directory that answers about worktrees without listing one", () => {
		const runner: Runner = () => ({ code: 0, stdout: "", stderr: "" });

		expect(() => planWorktree({ runner, repo: "/nowhere", branch: "feature/reader-8" })).toThrow(
			/not a git checkout/,
		);
	});
});

describe("parseWorktreeList", () => {
	test("reads a path containing a newline as the path, which the line form cannot", () => {
		const odd = "/tmp/a\nb";
		const parsed = parseWorktreeList(record([`worktree ${odd}`, "HEAD abc", "branch refs/heads/main"]));

		expect(parsed).toEqual([{ path: odd, branch: "main", prunable: false }]);
	});

	test("keeps reading past an attribute it does not know", () => {
		const parsed = parseWorktreeList(
			record([`worktree /a`, "HEAD abc", "locked", "something-git-learned later", "branch refs/heads/main"]),
		);

		expect(parsed).toEqual([{ path: "/a", branch: "main", prunable: false }]);
	});

	test("reads a bare primary, which carries no branch at all", () => {
		expect(parseWorktreeList(record(["worktree /a", "bare"]))).toEqual([
			{ path: "/a", branch: null, prunable: false },
		]);
	});
});

describe("ensureWorktree", () => {
	test("issues the plan's command", () => {
		const { repo, state } = primaryOn();
		const git = stubGit(state);
		const plan = planWorktree({ runner: git.runner, repo, branch: "feature/reader-8" });
		ensureWorktree(plan, git.runner);

		expect(git.issued[git.issued.length - 1]).toEqual([...plan.command!]);
	});

	test("runs nothing for a worktree that is already there", () => {
		const runner: Runner = (argv) => {
			throw new Error(`nothing should run: ${argv.join(" ")}`);
		};
		const plan = { kind: "attached", path: "/a", branch: "b", command: null, primary: "/p", warnings: [] } as const;

		expect(() => ensureWorktree(plan, runner)).not.toThrow();
	});

	test("reports what git said when the add fails, rather than a bare exit status", () => {
		const runner: Runner = () => ({ code: 128, stdout: "", stderr: "fatal: '/a' already exists\n" });
		const plan = {
			kind: "created",
			path: "/a",
			branch: "b",
			command: ["git", "worktree", "add", "/a", "-b", "b"],
			primary: "/p",
			warnings: [],
		} as const;

		expect(() => ensureWorktree(plan, runner)).toThrow(/already exists/);
	});

	test("falls back to the exit status where git failed without saying anything", () => {
		const runner: Runner = () => ({ code: 3, stdout: "", stderr: "" });
		const plan = {
			kind: "created",
			path: "/a",
			branch: "b",
			command: ["git", "worktree", "add", "/a", "-b", "b"],
			primary: "/p",
			warnings: [],
		} as const;

		expect(() => ensureWorktree(plan, runner)).toThrow(/git exited 3/);
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
	// The real path, which is what git reports back and therefore what every path below is compared
	// against; macOS hands `mkdtemp` a symlinked one.
	return realpathSync(root);
}

/**
 * Against real git rather than a stub, because every refusal here exists for a porcelain behaviour —
 * which directories `git worktree add` accepts, what it does with a branch already checked out
 * somewhere — and a stub asserting those asserts only what this file believes about them.
 */
describe("planWorktree and ensureWorktree against real git", () => {
	test("creates the branch and the worktree, and a second run attaches to what the first made", () => {
		const repo = realRepo();
		const first = planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" });
		expect(first.kind).toBe("created");
		ensureWorktree(first, defaultRunner);

		const second = planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" });
		expect(second.kind).toBe("attached");
		expect(second.path).toBe(first.path);
		expect(() => ensureWorktree(second, defaultRunner)).not.toThrow();
	});

	test("checks out a branch that exists without a worktree, where creating it would be fatal", () => {
		const repo = realRepo();
		expect(defaultRunner(["git", "-C", repo, "branch", "feature/reader-8"]).code).toBe(0);

		const plan = planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" });
		expect(plan.kind).toBe("checked-out");
		expect(() => ensureWorktree(plan, defaultRunner)).not.toThrow();
	});

	test("refuses a branch git has already handed to another worktree", () => {
		const repo = realRepo();
		const elsewhere = join(tempDir("nextup-elsewhere-"), "held");
		expect(defaultRunner(["git", "-C", repo, "worktree", "add", elsewhere, "-b", "feature/reader-8"]).code).toBe(0);

		expect(kindOf(() => planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" }))).toBe(
			"branch-elsewhere",
		);
	});

	test("refuses a stale directory where git would report a bare fatal", () => {
		const repo = realRepo();
		const path = join(repo, DEFAULT_WORKTREE_ROOT, "reader-8");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "leftover"), "half a checkout\n");

		expect(kindOf(() => planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" }))).toBe(
			"stale-directory",
		);
	});

	test("refuses the registration left behind when a worktree directory is deleted by hand", () => {
		const repo = realRepo();
		const plan = planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" });
		ensureWorktree(plan, defaultRunner);
		rmSync(plan.path, { recursive: true, force: true });

		expect(kindOf(() => planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" }))).toBe(
			"stale-directory",
		);
	});

	test("warns rather than refusing when the primary checkout has drifted off the default branch", () => {
		const repo = realRepo();
		expect(defaultRunner(["git", "-C", repo, "checkout", "--quiet", "-b", "wip"]).code).toBe(0);

		const plan = planWorktree({ runner: defaultRunner, repo, branch: "feature/reader-8" });
		expect(plan.warnings).toEqual([`the primary checkout ${repo} is on wip, not on main`]);
		expect(() => ensureWorktree(plan, defaultRunner)).not.toThrow();
	});

	test("cuts the branch from the primary checkout rather than from the worktree it was invoked in", () => {
		const repo = realRepo();
		const other = planWorktree({ runner: defaultRunner, repo, branch: "feature/other-3" });
		ensureWorktree(other, defaultRunner);
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

		const plan = planWorktree({ runner: defaultRunner, repo: other.path, branch: "feature/reader-8" });
		ensureWorktree(plan, defaultRunner);

		const merged = defaultRunner(["git", "-C", repo, "branch", "--contains", "feature/other-3"]).stdout;
		expect(merged).not.toContain("feature/reader-8");
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
