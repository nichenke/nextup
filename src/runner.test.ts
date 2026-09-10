import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerError, defaultRunner, gitEnvironment, refuseRedirectedGitHub } from "./runner";

describe("defaultRunner", () => {
	test("runs a real command and captures its output", () => {
		const result = defaultRunner(["echo", "hi"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});

	test("surfaces a missing binary as a distinct code with the error in stderr, not a blank exit 1", () => {
		const result = defaultRunner(["definitely-not-a-real-binary-xyz"]);
		expect(result.code).toBe(127);
		expect(result.stderr).not.toBe("");
	});

	// SIGABRT rather than any signal because that is how git dies on a `BUG:` assertion.
	test("gives a signal-killed command the code a shell would, and names the signal", () => {
		const result = defaultRunner(["bash", "-c", "kill -ABRT $$"]);
		expect(result.code).toBe(134);
		expect(result.stderr).toContain("SIGABRT");
	});
});

describe("gitEnvironment", () => {
	test("removes every GIT_-prefixed name, including one nobody has measured", () => {
		const { env } = gitEnvironment({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_SOMETHING_NEW: "1" });
		expect(env).toEqual({ PATH: "/bin" });
	});

	test("keeps everything else, so a tracker CLI sharing this seam still authenticates", () => {
		const { env } = gitEnvironment({ PATH: "/bin", HOME: "/home/someone", GH_TOKEN: "t", GITLAB_TOKEN: "u" });
		expect(env).toEqual({ PATH: "/bin", HOME: "/home/someone", GH_TOKEN: "t", GITLAB_TOKEN: "u" });
	});

	test("removes an empty value too, which git reads as a repository named the empty string", () => {
		const { env, reportable } = gitEnvironment({ GIT_DIR: "" });
		expect(env).toEqual({});
		expect(reportable).toEqual(["GIT_DIR"]);
	});

	test("reports what it removed, sorted, so one message reads the same run to run", () => {
		const { reportable } = gitEnvironment({ GIT_WORK_TREE: "/a", GIT_DIR: "/b", PATH: "/bin" });
		expect(reportable).toEqual(["GIT_DIR", "GIT_WORK_TREE"]);
	});

	test("stays quiet about the names measured as changing no answer", () => {
		const { env, reportable } = gitEnvironment({ GIT_EDITOR: "true", GIT_PAGER: "cat" });
		expect(reportable).toEqual([]);
		expect(env).toEqual({});
	});

	test("drops an unset name rather than passing it on as the string 'undefined'", () => {
		const { env } = gitEnvironment({ PATH: "/bin", TERM: undefined });
		expect(env).toEqual({ PATH: "/bin" });
	});

	// The prefix is `GIT_` and not `GIT`, so the tokens a tracker CLI authenticates with survive. Both edges
	// of that boundary, because widening it by one character is the plausible edit.
	test("keeps a name that begins with GIT but not with the prefix", () => {
		const { env, reportable } = gitEnvironment({ GITHUB_TOKEN: "t", GITLAB_TOKEN: "u", GIT_DIR: "/b" });
		expect(env).toEqual({ GITHUB_TOKEN: "t", GITLAB_TOKEN: "u" });
		expect(reportable).toEqual(["GIT_DIR"]);
	});

	test("removes the prefix itself, which is the shortest name it matches", () => {
		expect(gitEnvironment({ GIT_: "x" }).reportable).toEqual(["GIT_"]);
	});
});

const perTestRoots: string[] = [];

afterEach(() => {
	for (const root of perTestRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Two repositories, each with its own path as `origin`, so an origin read says which one answered. A path
 * rather than a URL because the identifier guard reads this file; `CLAUDE.md` has that.
 *
 * The caller registers what it built, because the two lifetimes here differ: the shared fixture outlives
 * every case, and a case building its own must not take the shared one down with it.
 */
function twoRepositories(): { root: string; intended: string; other: string } {
	const created = mkdtempSync(join(tmpdir(), "nextup-redirect-"));
	// Real, because git resolves symlinks in the paths it reports and macOS hands `mkdtemp` a symlinked one.
	const root = realpathSync(created);
	for (const name of ["intended", "other"]) {
		const path = join(root, name);
		expect(defaultRunner(["git", "init", "--quiet", "--initial-branch", "main", path]).code).toBe(0);
		expect(defaultRunner(["git", "-C", path, "remote", "add", "origin", path]).code).toBe(0);
	}
	return { root, intended: join(root, "intended"), other: join(root, "other") };
}

let sharedRepositories: ReturnType<typeof twoRepositories> | undefined;

/**
 * One fixture for every case that only reads, rebuilt for none of them.
 *
 * Built on first use rather than at import, because a run whose tests are all filtered out would otherwise
 * build it, assert inside it outside any test, and leave it behind — measured as one stray directory, of the
 * kind `scripts/guard-harness.ts` records accumulating 3502 of.
 */
function shared(): ReturnType<typeof twoRepositories> {
	sharedRepositories ??= twoRepositories();
	return sharedRepositories;
}

afterAll(() => {
	if (sharedRepositories) rmSync(sharedRepositories.root, { recursive: true, force: true });
});

/**
 * Runs `body` against this module in a child process whose environment is `overrides` plus the `PATH` and
 * `HOME` Bun needs to start at all.
 *
 * A child rather than a call, because Bun hands an inherited child the environment as it stood at *startup*:
 * a variable assigned into `process.env` mid-run never reaches a git process, so a case setting one that way
 * asserts nothing about the scrub and passes without it.
 *
 * Built rather than inherited for the same reason in reverse: a `GIT_` name in the developer's shell must not
 * be able to decide a result.
 */
function inChildProcess(body: string, overrides: Readonly<Record<string, string>>): { stdout: string; stderr: string } {
	const source = `import { defaultRunner } from ${JSON.stringify(join(import.meta.dir, "runner"))};\n${body}`;
	const result = spawnSync({
		cmd: ["bun", "-e", source],
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...overrides },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = result.stderr.toString();
	// The child's own stderr in the message, or a failure to start it reports only its exit code.
	expect(result.exitCode, `child exited ${result.exitCode}: ${stderr}`).toBe(0);
	return { stdout: result.stdout.toString(), stderr };
}

/** `body` for a child that prints one command's stdout, with `argv` written into it verbatim. */
function printing(argv: readonly string[]): string {
	return `process.stdout.write(defaultRunner(${JSON.stringify(argv)}).stdout);`;
}

/**
 * Against real git rather than a stub: each case exists for a behaviour of git's own — which variable
 * overrides `-C`, and which of this tool's commands it reaches — and a stub asserting those asserts only
 * what this file believes about them. ADR-0029 records the measurements they were written from.
 */
describe("a git variable exported before the tool started", () => {
	test("does not redirect the origin read, which decides whose tickets a run considers", () => {
		const { stdout } = inChildProcess(printing(["git", "-C", shared().intended, "remote", "get-url", "origin"]), {
			GIT_DIR: join(shared().other, ".git"),
		});
		expect(stdout.trim()).toBe(shared().intended);
	});

	test("does not redirect the worktree root, where GIT_WORK_TREE reaches and worktree list does not", () => {
		const { stdout } = inChildProcess(
			printing(["git", "-C", shared().intended, "rev-parse", "--path-format=absolute", "--show-toplevel"]),
			{ GIT_WORK_TREE: shared().other },
		);
		expect(realpathSync(stdout.trim())).toBe(shared().intended);
	});

	test("does not redirect the origin read through a global config file", () => {
		const config = join(shared().root, "config-naming-other");
		writeFileSync(config, `[remote "origin"]\n\turl = ${shared().other}\n`);
		const { stdout } = inChildProcess(printing(["git", "-C", shared().intended, "remote", "get-url", "origin"]), {
			GIT_CONFIG_GLOBAL: config,
		});
		expect(stdout.trim()).toBe(shared().intended);
	});

	test("is scrubbed for git named by an absolute path, not only by the bare word", () => {
		const binary = Bun.which("git");
		expect(binary).not.toBeNull();
		const { stdout } = inChildProcess(printing([binary as string, "-C", shared().intended, "remote", "get-url", "origin"]), {
			GIT_DIR: join(shared().other, ".git"),
		});
		expect(stdout.trim()).toBe(shared().intended);
	});

	test("does not reach git as an empty value, which git rejects as a repository name at 128", () => {
		const { stdout } = inChildProcess(
			`process.stdout.write(String(defaultRunner(${JSON.stringify(["git", "-C", shared().intended, "remote", "get-url", "origin"])}).code));`,
			{ GIT_DIR: "" },
		);
		expect(stdout.trim()).toBe("0");
	});

	test("does not abort a command it aborts unscrubbed", () => {
		// GIT_REPLACE_REF_BASE without a trailing slash aborts `worktree add` on a `BUG:` assertion, exit 134.
		// Its own fixture, because this is the one case that writes.
		const { root, intended } = twoRepositories();
		perTestRoots.push(root);
		expect(defaultRunner(["git", "-C", intended, "-c", "user.email=n@invalid", "-c", "user.name=n", "commit", "--quiet", "--allow-empty", "-m", "init"]).code).toBe(0);
		const argv = ["git", "-C", intended, "worktree", "add", join(root, "added"), "-b", "added"];
		const { stdout } = inChildProcess(`process.stdout.write(String(defaultRunner(${JSON.stringify(argv)}).code));`, {
			GIT_REPLACE_REF_BASE: "refs/other",
		});
		expect(stdout.trim()).toBe("0");
	});

	test("still reaches a command that is not git, which is how gh and glab keep their credentials", () => {
		const { stdout } = inChildProcess(printing(["printenv", "GIT_DIR"]), { GIT_DIR: "/elsewhere/.git" });
		expect(stdout.trim()).toBe("/elsewhere/.git");
	});
});

describe("the removal notice", () => {
	function twoGitCalls(overrides: Readonly<Record<string, string>>): string {
		return inChildProcess(`defaultRunner(["git", "--version"]);\ndefaultRunner(["git", "--version"]);`, overrides).stderr;
	}

	test("names every variable it removed, and that their configuration went with them", () => {
		const stderr = twoGitCalls({ GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere" });
		expect(stderr).toContain("GIT_DIR");
		expect(stderr).toContain("GIT_WORK_TREE");
		expect(stderr).toMatch(/configured/);
	});

	test("says it once for a whole run, not once per git command", () => {
		expect(twoGitCalls({ GIT_DIR: "/elsewhere/.git" }).match(/GIT_DIR/g)).toHaveLength(1);
	});

	// Absence of the notice rather than an empty stream: the child is a whole Bun process, and owning its
	// stderr byte for byte would fail on any diagnostic of Bun's own.
	test("stays silent when nothing was removed", () => {
		expect(twoGitCalls({})).not.toContain("was removed");
	});

	test("stays silent about a variable measured as changing no answer", () => {
		expect(twoGitCalls({ GIT_EDITOR: "true" })).not.toContain("was removed");
	});

	test("stays silent for a command that is not git, whose environment was not touched", () => {
		const { stderr } = inChildProcess(`defaultRunner(["printenv", "GIT_DIR"]);`, { GIT_DIR: "/elsewhere/.git" });
		expect(stderr).not.toContain("was removed");
	});
});

describe("refuseRedirectedGitHub", () => {
	const GH = ["gh", "issue", "list", "--repo", "example/repo"];

	test("refuses a gh command when the environment names a host for it", () => {
		expect(() => refuseRedirectedGitHub(GH, { GH_HOST: "github.example.test" })).toThrow(RunnerError);
		expect(() => refuseRedirectedGitHub(GH, { GH_HOST: "github.example.test" })).toThrow(/GH_HOST/);
	});

	// Refused rather than compared, so the rule needs no host parsing at a seam that cannot import it.
	test("refuses GitHub's own host too, since nothing here needs the variable", () => {
		expect(() => refuseRedirectedGitHub(GH, { GH_HOST: "github.com" })).toThrow(RunnerError);
	});

	test("allows an absent or empty variable, which is every ordinary environment", () => {
		expect(() => refuseRedirectedGitHub(GH, {})).not.toThrow();
		expect(() => refuseRedirectedGitHub(GH, { GH_HOST: undefined })).not.toThrow();
		expect(() => refuseRedirectedGitHub(GH, { GH_HOST: "" })).not.toThrow();
	});

	// git carries its own redirection rules, and `glab` and `jira` are not this rule's business.
	test("leaves a command that is not gh alone", () => {
		expect(() => refuseRedirectedGitHub(["git", "status"], { GH_HOST: "github.example.test" })).not.toThrow();
		expect(() => refuseRedirectedGitHub(["glab", "issue", "list"], { GH_HOST: "github.example.test" })).not.toThrow();
	});

	test("reads the binary's final path segment, so an absolute path is covered", () => {
		expect(() => refuseRedirectedGitHub(["/opt/homebrew/bin/gh", "issue", "list"], { GH_HOST: "x" })).toThrow(RunnerError);
	});
});
