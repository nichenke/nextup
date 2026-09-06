import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAIM_FAILURE_STATUS, type CliDeps, WARNING_PREFIX, WORKTREE_FAILURE_STATUS, run } from "./cli";
import type { Runner } from "./runner";
import { DEGRADED_PREFIX } from "./selection-output";

/** Every test below runs through this, so a call that started shelling out fails loudly here first. */
const refuseToRun: Runner = (argv) => {
	throw new Error(`nothing may run an external process here: ${argv.join(" ")}`);
};

/**
 * A terminal that answers the gate, and a record of what it was shown. Approving by default keeps the
 * tests below about what they are named for; the gate has its own describe block.
 */
function terminal(answer = true): { confirm: CliDeps["confirm"]; questions: string[] } {
	const questions: string[] = [];
	return {
		questions,
		confirm: (question) => {
			questions.push(question);
			return answer;
		},
	};
}

/**
 * A git that answers the worktree step, and makes on disk what it reports having made. The step reads
 * the filesystem to decide whether a path is free and whether the effort reaches the worktree, so a
 * runner that reported an add without creating anything would be answering a question git does not.
 */
function fakeGit(primary: string, over: Partial<FakeGit> = {}): Runner {
	const { branch, branches, efforts, scratchIsAFile }: FakeGit = { ...FAKE_GIT, ...over };
	const added: { path: string; branch: string }[] = [];
	return (argv) => {
		const words = argv.join(" ");
		if (words.includes("worktree list")) {
			const all = [{ path: primary, branch }, ...added];
			const stdout = all.map((one) => `worktree ${one.path}\0HEAD abc\0branch refs/heads/${one.branch}\0\0`).join("");
			return { code: 0, stdout, stderr: "" };
		}
		if (words.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
		if (words.includes("show-ref")) {
			const ref = argv[argv.length - 1]!.replace("refs/heads/", "");
			return { code: branches.includes(ref) ? 0 : 1, stdout: "", stderr: "" };
		}
		if (words.includes("worktree add")) {
			const path = argv[argv.indexOf("add") + 1]!;
			mkdirSync(path, { recursive: true });
			if (scratchIsAFile) writeFileSync(join(path, ".scratch"), "a file where .scratch should be\n");
			for (const carried of efforts) {
				// A whole effort, not just the directory: `isEffortRoot` wants a `map.md` beside `issues/`,
				// and a checkout of a branch carrying the effort produces both.
				mkdirSync(join(path, carried, "issues"), { recursive: true });
				writeFileSync(join(path, carried, "map.md"), "## Destination\n\nSomewhere.\n");
			}
			added.push({ path, branch: argv[argv.length - 1]! });
			return { code: 0, stdout: "", stderr: "" };
		}
		return refuseToRun(argv);
	};
}

interface FakeGit {
	/** What the primary checkout is on, which the worktree step warns about drifting. */
	readonly branch: string;
	/** Branches the repository already has, which decides between creating and checking out. */
	readonly branches: readonly string[];
	/**
	 * Effort directories the checkout carries, relative to the repo root. Empty stands for an effort
	 * left untracked, which no worktree of the branch holds.
	 */
	readonly efforts: readonly string[];
	/** A worktree whose `.scratch` cannot be listed, which is what makes discovery throw. */
	readonly scratchIsAFile: boolean;
}

const FAKE_GIT: FakeGit = { branch: "main", branches: [], efforts: [".scratch/an-effort"], scratchIsAFile: false };

function deps(cwd: string, confirm: CliDeps["confirm"] = terminal().confirm, runner = fakeGit(cwd)): CliDeps {
	return { cwd, runner, confirm };
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "nextup-cli-"));
	roots.push(root);
	// The real path, for the reason `resolveReal` in cli.ts gives.
	return realpathSync(root);
}

function writeEffort(repoRoot: string, effort: string, files: Record<string, string>): string {
	const effortRoot = join(repoRoot, ".scratch", effort);
	mkdirSync(join(effortRoot, "issues"), { recursive: true });
	writeFileSync(join(effortRoot, "map.md"), "## Destination\n\nSomewhere.\n");
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(effortRoot, "issues", name), body);
	}
	return effortRoot;
}

function ticketPath(effortRoot: string, name: string): string {
	return join(effortRoot, "issues", name);
}

/** Two open tickets, the second waiting on the first, so the answer is never a coin toss. */
function chainedEffort(repoRoot: string, effort = "an-effort"): string {
	return writeEffort(repoRoot, effort, {
		"01-first.md": "# 01 — Settle the format\n\nStatus: open\n",
		"02-second.md": "# 02 — Write the reader\n\nStatus: open\nBlocked by: 01\n",
	});
}

describe("run", () => {
	test("names the ticket to start next, and why, from the one effort it finds", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:1 — Settle the format");
		expect(result.stdout).toContain("unblocks 1");
		expect(result.stderr).toBe("");
	});

	test("emits the selection as JSON on request", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--json"], deps(repo));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).pick.ref).toBe("md:1");
	});

	test("reads an effort the command line points at, wherever it is kept", () => {
		const repo = tempRepo();
		const elsewhere = join(repo, "docs", "efforts", "an-effort");
		mkdirSync(join(elsewhere, "issues"), { recursive: true });
		writeFileSync(join(elsewhere, "map.md"), "## Destination\n\nSomewhere.\n");
		writeFileSync(join(elsewhere, "issues", "05-only.md"), "# 05 — Something else\n\nStatus: open\n");
		const result = run(["--yes", "--effort", elsewhere], deps(repo, terminal().confirm, fakeGit(repo, { efforts: [] })));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:5 — Something else");
	});

	test("refuses a checkout holding several efforts, and does not offer --effort as the way out", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		chainedEffort(repo, "two");
		const result = run([], deps(repo));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("one to a checkout");
		expect(result.stderr).toContain("one");
		expect(result.stderr).toContain("two");
	});

	test("refuses several efforts even when --effort picks between them, since that is the collision", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		const other = writeEffort(repo, "two", { "01-first.md": "# 01 — Settle the format\n\nStatus: open\n" });

		// Both efforts number from 1, so both give md:1 the same identity and the same branch at the
		// same path — starting the second would attach to the first's worktree.
		const result = run(["--yes", "--effort", other], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("one to a checkout");
	});

	test("says plainly when there is no effort to read", () => {
		const result = run([], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(".scratch");
	});

	test("reports a refused effort as an error rather than an errno", () => {
		const repo = tempRepo();
		const result = run(["--effort", join(repo, "nowhere")], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not an effort");
	});

	test("exits non-zero, but not as an error, when there is nothing to recommend", () => {
		const repo = tempRepo();
		writeEffort(repo, "stuck", {
			"01-first.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-second.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run([], deps(repo));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
		expect(result.stderr).toBe("");
	});

	// A ticket file that cannot be read vanishes from the effort. Without a signal the pick reads as
	// confident, and the ticket that would have won may be the one that vanished.
	test("degrades rather than presenting an effort it could not fully read as complete", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "partial", { "09-chore.md": "# 09 — Low priority chore\n\nStatus: open\n" });
		symlinkSync("/nonexistent/gone.md", join(effort, "issues", "01-critical.md"));

		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").some((line) => line.startsWith(DEGRADED_PREFIX))).toBe(true);
		expect(JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout).degraded).toEqual(["truncated"]);
	});

	test("reads an effort with only real ticket files as complete", () => {
		const repo = tempRepo();
		writeEffort(repo, "whole", {
			"01-a.md": "# 01 — First\n\nStatus: open\n",
			"README.md": "Not a ticket, and not a gap.\n",
		});
		expect(JSON.parse(run(["--json"], deps(repo)).stdout).degraded).toEqual([]);
	});

	test("carries the degraded sentinel into the human rendering", () => {
		const repo = tempRepo();
		writeEffort(repo, "degraded", {
			"01-first.md": "# 01 — Support the legacy format\n\nStatus: wontfix\n",
			"02-second.md": "# 02 — Read a legacy archive\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").some((line) => line.startsWith(DEGRADED_PREFIX))).toBe(true);
	});
});

describe("the label filter flags", () => {
	function triageEffort(repoRoot: string): void {
		writeEffort(repoRoot, "triage", {
			"01-first.md": "# 01 — Needs a person\n\nStatus: ready-for-human\n",
			"02-second.md": "# 02 — Ready to build\n\nStatus: ready-for-agent\n",
		});
	}

	test("drops an excluded label", () => {
		const repo = tempRepo();
		triageEffort(repo);
		expect(run(["--exclude", "ready-for-human"], deps(repo)).stdout).toContain("md:2");
	});

	test("keeps only an included label", () => {
		const repo = tempRepo();
		triageEffort(repo);
		expect(run(["--include", "ready-for-human"], deps(repo)).stdout).toContain("md:1");
	});

	test("takes both flags more than once", () => {
		const repo = tempRepo();
		triageEffort(repo);
		const result = run(["--exclude", "ready-for-human", "--exclude", "ready-for-agent"], deps(repo));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
	});

	test("keeps the wayfinder exclusion under a filter flag that never mentioned wayfinder", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		expect(JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout).filter.exclude).toEqual(["wayfinder:*"]);
		const included = run(["--json", "--print-command", "--include", "ready-for-agent"], deps(repo));
		expect(JSON.parse(included.stdout).filter).toEqual({ include: ["ready-for-agent"], exclude: ["wayfinder:*"] });
		const excluded = run(["--json", "--print-command", "--exclude", "needs-info"], deps(repo));
		expect(JSON.parse(excluded.stdout).filter).toEqual({ include: [], exclude: ["wayfinder:*", "needs-info"] });
	});

	test("refuses a pattern the grammar does not accept", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--exclude", "way*er"], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("way*er");
	});
});

/**
 * `run` returns its output as a string, so nothing above this reaches the process streams that
 * `bin/nextup.ts` writes to. These drive the real executable.
 */
describe("bin/nextup.ts", () => {
	const BIN = join(dirname(import.meta.dir), "bin", "nextup.ts");

	/** Enough tickets that the JSON exceeds a 64KB pipe buffer and a writer can outrun its reader. */
	function largeEffort(repoRoot: string): string {
		const files: Record<string, string> = {};
		for (let number = 1; number <= 400; number++) {
			files[`${number}-t.md`] = `# ${number} — Ticket number ${number}, titled at length to pad the document\n\nStatus: open\n`;
		}
		return writeEffort(repoRoot, "large", files);
	}

	test("delivers the whole JSON document to a reader slower than itself", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync(["sh", "-c", `bun ${BIN} --json --print-command --effort ${effort} | (sleep 1; cat)`]);
		const direct = Bun.spawnSync(["bun", BIN, "--json", "--print-command", "--effort", effort]);

		expect(direct.stdout.length).toBeGreaterThan(65536);
		expect(piped.stdout.toString()).toBe(direct.stdout.toString());
		expect(JSON.parse(piped.stdout.toString()).counts.tickets).toBe(400);
	});

	test("exits on a pick as a pick when the reader closes early", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync([
			"bash",
			"-c",
			`bun ${BIN} --json --print-command --effort ${effort} | head -c 200 > /dev/null; echo \${PIPESTATUS[0]}`,
		]);
		expect(piped.stdout.toString().trim()).toBe("0");
		expect(piped.stderr.toString()).not.toContain("EPIPE");
	});

	test("exits 0 on a pick, 1 with nothing to recommend, and 2 on a bad invocation", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", effort]).exitCode).toBe(0);

		const stuck = writeEffort(repo, "stuck", {
			"01-a.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-b.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", stuck]).exitCode).toBe(1);
		expect(Bun.spawnSync(["bun", BIN, "--rank-by", "size"]).exitCode).toBe(2);
	});

	// Bun.spawnSync gives the child no controlling terminal, which is the unattended case itself: the
	// gate has nobody to ask and the run is refused rather than answered for.
	test("refuses to claim with no terminal to ask on, and claims under --yes", () => {
		const effort = chainedEffort(tempRepo());
		expect(Bun.spawnSync(["bun", BIN, "--effort", effort]).exitCode).toBe(2);
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", effort]).exitCode).toBe(0);
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], deps(tempRepo()));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--effort");
		expect(result.stdout).toContain("--json");
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--effort"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--effort");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["md:1"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("md:1");
	});
});

describe("claiming the pick", () => {
	test("claims the winner in the tracker, and says what it would run on it", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const result = run(["--yes"], deps(repo));

		expect(result.code).toBe(0);
		expect(readFileSync(ticketPath(effort, "01-first.md"), "utf8")).toContain("Status: claimed");
		expect(result.stdout).toContain("claimed md:1");
		expect(result.stdout).toContain("would run: claude '/implement md:1'");
	});

	test("hands the next run a different ticket, because the first one is claimed", () => {
		const repo = tempRepo();
		writeEffort(repo, "two-ready", {
			"01-first.md": "# 01 — Settle the format\n\nStatus: open\n",
			"02-second.md": "# 02 — Write the reader\n\nStatus: open\n",
		});

		expect(run([], deps(repo)).stdout).toContain("claimed md:1");
		expect(run([], deps(repo)).stdout).toContain("claimed md:2");
		expect(run([], deps(repo)).code).toBe(1);
	});

	// A claim left on a ticket the selector will now skip forever needs a person, not a retry — the
	// same answer as a ticket set that will not read, and never the one that says come back later.
	test("reports a claim it could not take back as needing a person", () => {
		expect(CLAIM_FAILURE_STATUS.stranded).toBe(2);
		expect(CLAIM_FAILURE_STATUS.unavailable).toBe(3);
	});

	test("reports a ticket set that will not take a claim as one to fix", () => {
		const readOnly = tempRepo();
		const effort = chainedEffort(readOnly);
		chmodSync(ticketPath(effort, "01-first.md"), 0o444);
		const refused = run([], deps(readOnly));
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain("01-first.md");

		const malformed = tempRepo();
		writeEffort(malformed, "an-effort", { "01-first.md": "# 01 — A\n\n**Status: op**en\n" });
		expect(run([], deps(malformed)).code).toBe(2);
	});

	test("carries the claim and the command in the JSON, so a caller needs no second invocation", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const document = JSON.parse(run(["--json"], deps(repo)).stdout);

		expect(document.claimed).toBe(true);
		expect(document.command).toEqual(["claude", "/implement md:1"]);
	});
});

describe("ensuring the worktree", () => {
	test("creates the worktree for the pick once the claim has landed, and says where it went", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run([], deps(repo));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("claimed md:1");
		expect(result.stdout).toContain(`created feature/settle-the-format-1 at ${join(repo, ".worktrees", "settle-the-format-1")}`);
		expect(existsSync(join(repo, ".worktrees", "settle-the-format-1"))).toBe(true);
		expect(result.stderr).toBe("");
	});

	test("says it checked out rather than created where the branch was already there", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run([], deps(repo, terminal().confirm, fakeGit(repo, { branches: ["feature/settle-the-format-1"] })));

		expect(result.stdout).toContain("checked out feature/settle-the-format-1 at");
	});

	test("puts the worktree under the root it was given, so another launcher can site it elsewhere", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--worktree-root", "trees"], deps(repo));

		expect(result.stdout).toContain(join(repo, "trees", "settle-the-format-1"));
	});

	test("carries the worktree in the JSON, so a caller needs no second invocation for it either", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const document = JSON.parse(run(["--json"], deps(repo)).stdout);

		expect(document.worktree).toEqual({
			kind: "created",
			branch: "feature/settle-the-format-1",
			path: join(repo, ".worktrees", "settle-the-format-1"),
			warnings: [],
		});
	});

	test("gives the claim back when the worktree could not even be planned, since nothing was made", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const blind: Runner = (argv) =>
			argv.join(" ").includes("worktree list")
				? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
				: refuseToRun(argv);
		const result = run([], deps(repo, terminal().confirm, blind));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not a git repository");
		expect(readFileSync(ticketPath(effort, "01-first.md"), "utf8")).toContain("Status: open");
	});

	test("keeps the claim when the worktree itself failed, because the branch is half made", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const failing: Runner = (argv) =>
			argv.join(" ").includes("worktree add")
				? { code: 128, stdout: "", stderr: "fatal: could not create leading directories" }
				: fakeGit(repo)(argv);
		const result = run([], deps(repo, terminal().confirm, failing));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("md:1 stays claimed");
		expect(readFileSync(ticketPath(effort, "01-first.md"), "utf8")).toContain("Status: claimed");
	});

	test("warns about a primary checkout that has drifted off the default branch, and still claims", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run([], deps(repo, terminal().confirm, fakeGit(repo, { branch: "wip" })));

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(`${WARNING_PREFIX}the primary checkout ${repo} is on wip, not on main\n`);
	});

	test("warns when the effort does not reach the worktree, since md:1 there would resolve to nothing", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run([], deps(repo, terminal().confirm, fakeGit(repo, { efforts: [] })));

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("cannot resolve md:1");
		expect(result.stderr).toContain("commit the effort on the branch");
	});

	test("gives the JSON the same warnings it printed, not the shorter list the plan carried", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--json"], deps(repo, terminal().confirm, fakeGit(repo, { branch: "wip", efforts: [] })));
		const warnings: string[] = JSON.parse(result.stdout).worktree.warnings;

		expect(warnings).toHaveLength(2);
		expect(result.stderr).toBe(warnings.map((one) => `${WARNING_PREFIX}${one}\n`).join(""));
	});

	test("exits 2 on every way of failing to ensure one, since none leaves a ticket another run can take", () => {
		expect(new Set(Object.values(WORKTREE_FAILURE_STATUS))).toEqual(new Set([2]));
	});

	test("warns when the worktree carries several efforts, since a bare reference then names none", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const carried = [".scratch/an-effort", ".scratch/another-effort"];
		const result = run([], deps(repo, terminal().confirm, fakeGit(repo, { efforts: carried })));

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("holds 2 efforts rather than one");
		expect(result.stderr).toContain("cannot resolve md:1");
	});

	test("warns when the effort is in the worktree but not where an effort is looked for", () => {
		const repo = tempRepo();
		const outside = join("docs", "efforts", "an-effort");
		const effortRoot = join(repo, outside);
		mkdirSync(join(effortRoot, "issues"), { recursive: true });
		writeFileSync(join(effortRoot, "map.md"), "## Destination\n\nSomewhere.\n");
		writeFileSync(join(effortRoot, "issues", "01-first.md"), "# 01 — Settle the format\n\nStatus: open\n");
		const result = run(["--effort", effortRoot], deps(repo, terminal().confirm, fakeGit(repo, { efforts: [outside] })));

		// Present on disk and still unreachable: `md:1` is resolved through `.scratch`, so an effort
		// committed anywhere else is a reference that finds nothing while every file it names is there.
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("is not the effort discovered there");
		expect(result.stderr).toContain("cannot resolve md:1");
	});

	test("warns rather than dying when the worktree cannot be asked what efforts it holds", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const git = fakeGit(repo, { efforts: [], scratchIsAFile: true });

		// The claim landed and the worktree was built, so there is nothing left to refuse. Thrown from
		// here the error reached no catch and killed a run that had already succeeded.
		const result = run([], deps(repo, terminal().confirm, git));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("claimed md:1");
		expect(result.stderr).toContain("could not be determined");
	});

	test("asks where the effort sits in its own checkout, not where it sits in the primary one", () => {
		const repo = tempRepo();
		const primary = join(repo, "primary");
		mkdirSync(primary, { recursive: true });
		const invokedIn = join(repo, "linked");
		chainedEffort(invokedIn);

		// Measured against the primary checkout the effort is at `../linked/.scratch/an-effort`, which
		// reads as outside it; measured against the checkout it was found in, it is where it belongs.
		const result = run([], deps(invokedIn, terminal().confirm, fakeGit(primary)));
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
	});

	test("warns when the effort is outside the checkout the worktree was cut from", () => {
		const repo = tempRepo();
		const elsewhere = tempRepo();
		chainedEffort(elsewhere);
		const result = run(["--effort", join(elsewhere, ".scratch", "an-effort")], deps(repo));

		expect(result.code).toBe(0);
		expect(result.stderr).toContain(`is outside ${repo}`);
	});

	test("a declined pick makes no worktree, having claimed nothing to make one for", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run([], deps(repo, terminal(false).confirm, refuseToRun));

		expect(result.code).toBe(1);
		expect(existsSync(join(repo, ".worktrees"))).toBe(false);
	});
});

describe("--print-command", () => {
	test("emits the launch command and claims nothing", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const result = run(["--print-command"], deps(repo));

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("claude '/implement md:1'\n");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("keeps why the ticket won off the stream carrying the command", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--print-command"], deps(repo));

		expect(result.stderr).toContain("md:1 — Settle the format");
		expect(result.stdout).not.toContain("Settle the format");
	});

	test("says so on stderr, and prints no command, when there is nothing to start", () => {
		const repo = tempRepo();
		writeEffort(repo, "stuck", {
			"01-first.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-second.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run(["--print-command"], deps(repo));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no candidate to recommend");
	});

	test("reports the selection as JSON without claiming, which is the whole read-only answer", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const document = JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout);

		expect(document.claimed).toBe(false);
		expect(document.command).toEqual(["claude", "/implement md:1"]);
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});
});

describe("the confirmation gate", () => {
	test("shows the pick and what approving it runs, then claims only once approved", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const asked = terminal();

		const result = run([], deps(repo, asked.confirm));

		expect(asked.questions).toHaveLength(1);
		expect(asked.questions[0]).toContain("md:1 — Settle the format");
		expect(asked.questions[0]).toContain("would run: claude '/implement md:1'");
		expect(asked.questions[0]).toContain("[y/N]");
		expect(result.code).toBe(0);
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).toContain("Status: claimed");
	});

	test("claims nothing when the pick is declined, and says so", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);

		const result = run([], deps(repo, terminal(false).confirm));

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("md:1 not claimed");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("a declined pick reports the command it did not run, and no claim", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const declined = run(["--json"], deps(repo, terminal(false).confirm));
		const document = JSON.parse(declined.stdout);

		expect(declined.code).toBe(1);
		expect(document.claimed).toBe(false);
		expect(document.command).toEqual(["claude", "/implement md:1"]);
	});

	// The gate holds the window between selection and claim open for as long as a person takes to
	// answer, so what was startable when it was asked may not be when it is answered. Blockedness is
	// the check the claim step cannot make for itself: it reads one file, and this needs the graph.
	test("refuses a pick that became blocked while it was being confirmed", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const first = join(effort, "issues", "01-first.md");

		const result = run([], {
			cwd: repo,
			runner: refuseToRun,
			confirm: () => {
				writeFileSync(first, "# 01 — Settle the format\n\nStatus: open\nBlocked by: 02\n");
				return true;
			},
		});

		expect(result.code).toBe(3);
		expect(result.stderr).toContain("no longer the ticket to start");
		expect(readFileSync(first, "utf8")).not.toContain("claimed");
	});

	// Not blocked — unknown, with another candidate still confirmed unblocked. ADR-0003's partition
	// says the confirmed one wins outright, so claiming the stale pick would contradict the ranking
	// this tool exists to apply. Checking conditions by hand missed this; re-running the ladder cannot.
	test("refuses a pick that another candidate would now beat", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "two-ready", {
			"01-first.md": "# 01 — Settle the format\n\nStatus: open\n",
			"02-second.md": "# 02 — Write the reader\n\nStatus: open\n",
		});
		const first = join(effort, "issues", "01-first.md");

		const result = run([], {
			cwd: repo,
			runner: refuseToRun,
			confirm: () => {
				// A blocker no file in this effort carries: the pick goes unknown rather than blocked.
				writeFileSync(first, "# 01 — Settle the format\n\nStatus: open\nBlocked by: 99\n");
				return true;
			},
		});

		expect(result.code).toBe(3);
		expect(result.stderr).toContain("md:2 is now");
		expect(readFileSync(first, "utf8")).not.toContain("claimed");
		expect(readFileSync(join(effort, "issues", "02-second.md"), "utf8")).not.toContain("claimed");
	});

	test("reports a gate it could not put as a bad run, not as a decline", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const broken = () => {
			throw new Error("/dev/tty went away");
		};

		const result = run([], deps(repo, broken));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("could not be put");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("--yes claims without asking, which is what an unattended run needs", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const asked = terminal();

		const result = run(["--yes"], deps(repo, asked.confirm));

		expect(asked.questions).toEqual([]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("claimed md:1");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).toContain("Status: claimed");
	});

	test("refuses with nothing to ask on, naming the flag that means yes", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);

		const result = run([], deps(repo, null));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--yes");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("never asks about a run that claims nothing", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const asked = terminal();

		expect(run(["--print-command"], deps(repo, asked.confirm)).code).toBe(0);
		expect(run(["--print-command"], deps(repo, null)).code).toBe(0);
		expect(asked.questions).toEqual([]);
	});
});
