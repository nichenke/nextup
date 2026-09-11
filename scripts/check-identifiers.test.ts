import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner } from "../src/runner";
import { runGuardOn } from "./guard-harness";

const guardDirs = (): number => readdirSync(tmpdir()).filter((name) => name.startsWith("nextup-guard-")).length;

const decoys: string[] = [];

afterEach(() => {
	for (const root of decoys.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Fixtures the guard must reject are assembled at runtime, because this file is itself tracked
// and scanned. Splitting after a scheme's colon is no longer sufficient on its own, because the
// remainder is still a dotted host followed by a slash, which the schemeless shape matches. So each
// host is also split before its final label, leaving no fragment that carries two dotted labels
// ahead of a separator. A comment here cannot spell such a fragment out either -- doing so is what
// made the guard fail on this file while the tests all passed.
const unknownHttpsUrl = "https:" + "//internal.corp" + ".test/x";
const unknownSshUrl = "ssh:" + "//internal.corp" + ".test/group/repo.git";
const unknownGitUrl = "git:" + "//internal.corp" + ".test/group/repo.git";
const unknownScpRemote = "git@internal" + ".corp" + ".test:group/repo.git";
const unknownEmail = "person@internal" + ".corp.test";
const unknownRef = "private-org/repo" + "#7";
const unknownApiUrl = "https:" + "//api.github" + ".com/repos/private-org/repo/issues/7";
const hiddenAfterEscape =
	"https://example.com/issues/1\\n" + "https:" + "//internal.corp" + ".test/x";

const escapedSlashUrl = "https:" + "\\/\\/internal.corp" + ".test\\/x";
const escapedSlashAllowlisted = "https:" + "\\/\\/example.com" + "\\/issues\\/1";
const escapedBareHost = "https:" + "\\\\/\\\\/internal.corp" + ".test\\\\/x";

// The three schemeless shapes that reach a lockfile or a config without a human typing them.
const unknownImageRef = "mirror.internal.test" + "/team/app:1.2.3";
const unknownAuthLine = "//mirror.internal.test" + "/:_authToken=redacted";
const unknownSchemelessUrl = "mirror.internal.test" + "/pkg/tarball";

// An allowlisted repo URL must not vouch for a longer name that merely starts with it, nor for a
// private host smuggled into its query string. The second was live while acceptance was by prefix.
const lookalikeRepo = "https://github.com/nichenke/nextup" + "-mirror/x";
const nestedHostInQuery =
	"https://github.com/nichenke/nextup/issues/2" +
	"?redirect=https:" +
	"//internal.corp" +
	".test/x";

describe("runGuardOn", () => {
	test("leaves no temporary repository behind, on a pass or a failure", () => {
		const before = guardDirs();
		runGuardOn("See https://example.com/issues/1\n");
		runGuardOn(`Ticket at ${unknownHttpsUrl}\n`);
		expect(guardDirs()).toBe(before);
	});
});

describe("check-identifiers under a redirected git environment", () => {
	/**
	 * The guard as CI invokes it, in `cwd`. The environment is passed rather than inherited for the reason
	 * `runGuardOn` gives, so a case may set a variable and have the guard see it.
	 */
	function guardIn(cwd: string) {
		return spawnSync({ cmd: ["bash", join(import.meta.dir, "check-identifiers.sh")], cwd, env: { ...process.env } });
	}

	/** A throwaway repository at `root`, with `files` committed. Empty when none are given. */
	function repositoryWith(files: Readonly<Record<string, string>>): string {
		const root = mkdtempSync(join(tmpdir(), "nextup-decoy-"));
		decoys.push(root);
		expect(defaultRunner(["git", "init", "--quiet", root]).code).toBe(0);
		for (const [name, contents] of Object.entries(files)) {
			mkdirSync(join(root, dirname(name)), { recursive: true });
			writeFileSync(join(root, name), contents);
		}
		if (Object.keys(files).length > 0) {
			const identity = ["-c", "user.email=n@invalid", "-c", "user.name=n"];
			expect(defaultRunner(["git", "-C", root, "add", "-A"]).code).toBe(0);
			expect(defaultRunner(["git", "-C", root, ...identity, "commit", "--quiet", "-m", "init"]).code).toBe(0);
		}
		return root;
	}

	test("refuses a repository with nothing tracked, rather than reporting a pass", () => {
		const result = guardIn(repositoryWith({}));
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("nothing is tracked");
	});

	test("refuses a directory that is not a repository, naming the listing rather than the contents", () => {
		const root = mkdtempSync(join(tmpdir(), "nextup-decoy-"));
		decoys.push(root);
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("git ls-files failed");
	});

	// git honours any of its boolean spellings here, so the guard reads the value as a boolean rather than
	// comparing it to the one spelling `sparse-checkout init` happens to write.
	test("refuses a sparse checkout configured with another of git's boolean spellings", () => {
		const root = repositoryWith({ "a.md": `leak at ${unknownHttpsUrl}\n` });
		expect(defaultRunner(["git", "-C", root, "config", "core.sparseCheckout", "yes"]).code).toBe(0);
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("sparse checkout");
	});

	// `git ls-files` lists what is under the current directory, so a run from a subdirectory scanned a subset
	// and passed. The identifier sits outside the directory the guard is invoked from.
	test("scans the whole tree when run from a subdirectory, not the subtree it was started in", () => {
		const root = repositoryWith({ "keep/a.md": "clean\n", "drop/b.md": `leak at ${unknownHttpsUrl}\n` });
		const result = guardIn(join(root, "keep"));
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("refuses a sparse checkout, rather than scanning the part of the tree it has", () => {
		const root = repositoryWith({ "keep/a.md": "clean\n", "drop/b.md": `leak at ${unknownHttpsUrl}\n` });
		expect(defaultRunner(["git", "-C", root, "sparse-checkout", "init", "--cone"]).code).toBe(0);
		expect(defaultRunner(["git", "-C", root, "sparse-checkout", "set", "keep"]).code).toBe(0);
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("sparse checkout");
	});

	// Present but unreadable is skipped by the scan exactly as absent is, and only one of the two is a state
	// worth refusing. Root would bypass the mode bits, which `src/test-preload.ts` refuses the suite under.
	test("refuses a tracked file it cannot read, naming the file", () => {
		const root = repositoryWith({ "a.md": "clean\n", "secret.md": `leak at ${unknownHttpsUrl}\n` });
		chmodSync(join(root, "secret.md"), 0o000);
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("secret.md");
	});

	// The sibling of the case above, and the one `[ -e ]` could not answer: a path behind an unreadable
	// directory cannot be stat'ed at all, so it read as absent and was tolerated.
	test("refuses a tracked file hidden behind a directory it cannot enter", () => {
		const root = repositoryWith({ "a.md": "clean\n", "sub/b.md": `leak at ${unknownHttpsUrl}\n` });
		chmodSync(join(root, "sub"), 0o000);
		const result = guardIn(root);
		chmodSync(join(root, "sub"), 0o755);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("cannot be examined");
	});

	// Deleting a file without staging it is an everyday state, so the scan covers what is there.
	test("scans a tree with a tracked file deleted but not staged", () => {
		const root = repositoryWith({ "a.md": "clean\n", "b.md": `leak at ${unknownHttpsUrl}\n` });
		rmSync(join(root, "a.md"));
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	// `xargs` reads a leading hyphen as an option, so the scan rejected its own argument list, the error went
	// to /dev/null and the guard passed over the file.
	test("scans a tracked file whose name begins with a hyphen", () => {
		const root = repositoryWith({ "-d": `leak at ${unknownHttpsUrl}\n` });
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	// The one name `--` does not rescue, because grep reads it as standard input rather than as an option:
	// the file above is scanned, this one was passed over with `ok`.
	test("refuses a tracked file named as a lone hyphen, which grep would read as standard input", () => {
		const root = repositoryWith({ "-": `leak at ${unknownHttpsUrl}\n` });
		const result = guardIn(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("read as standard input");
	});

	test("scans the fixture rather than reporting ok on nothing", () => {
		const before = process.env.GIT_DIR;
		// An empty repository for GIT_DIR to name; a missing path would fail the listing rather than empty it.
		process.env.GIT_DIR = join(repositoryWith({}), ".git");
		try {
			const result = runGuardOn(`Ticket at ${unknownHttpsUrl}\n`);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).toContain("internal.corp.test");
		} finally {
			if (before === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = before;
		}
	});
});

describe("check-identifiers", () => {
	test("passes tokens that are on the allowlist", () => {
		const result = runGuardOn("See https://example.com/issues/1\n");
		expect(result.exitCode).toBe(0);
	});

	// One test per scheme would be endless, so these three stand for the class: the guard does
	// not know or care which schemes exist, it only knows which exact tokens are permitted.
	test("fails an unrecognised https URL", () => {
		const result = runGuardOn(`Ticket at ${unknownHttpsUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised ssh URL that omits the user", () => {
		const result = runGuardOn(`origin ${unknownSshUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised git-protocol URL", () => {
		const result = runGuardOn(`origin ${unknownGitUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised scp-form remote", () => {
		const result = runGuardOn(`origin ${unknownScpRemote}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised email address", () => {
		const result = runGuardOn(`Contact ${unknownEmail}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised cross-repo issue reference", () => {
		const result = runGuardOn(`Tracked in ${unknownRef}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	// An allowlisted host does not vouch for the path under it. The API host is allowlisted, so a
	// private owner in a `/repos/{owner}/{repo}` route is only caught because the whole URL is
	// the token.
	test("fails an API URL whose owner is not allowlisted", () => {
		const result = runGuardOn(`Fetched ${unknownApiUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	// Escape sequences carry no whitespace, so grep returns both URLs as one token. Truncating at
	// the escape hid the second one behind an allowlisted first.
	test("fails an unrecognised URL hidden after an escape sequence", () => {
		const result = runGuardOn(`const x = "${hiddenAfterEscape}"\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails an unrecognised URL written with escaped slashes", () => {
		const result = runGuardOn(`const x = "${escapedSlashUrl}"\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("passes an allowlisted URL written with escaped slashes", () => {
		const result = runGuardOn(`const x = "${escapedSlashAllowlisted}"\n`);
		expect(result.exitCode).toBe(0);
	});

	// This is the nearest input the fix does not catch, recorded rather than fixed. A doubled
	// backslash is an escaped backslash, so unescaping consumes one pair and leaves the host
	// followed by a backslash rather than a separator -- which lands it in the bare-host gap the
	// test below documents. Out of contract because it is not a form any tool writes: a lockfile,
	// an .npmrc and a container manifest all emit either a plain or a singly-escaped slash. Widen
	// this only alongside bare-host matching, since the two share one cause.
	test("does not catch a host behind a doubled backslash", () => {
		const result = runGuardOn(`const x = "${escapedBareHost}"\n`);
		expect(result.exitCode).toBe(0);
	});

	test("fails a container image reference with no scheme", () => {
		const result = runGuardOn(`image: ${unknownImageRef}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("mirror.internal.test");
	});

	test("fails an npmrc-style auth line with no scheme", () => {
		const result = runGuardOn(`${unknownAuthLine}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("mirror.internal.test");
	});

	test("fails a schemeless URL", () => {
		const result = runGuardOn(`resolved ${unknownSchemelessUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("mirror.internal.test");
	});

	// A bare dotted host with nothing after it is deliberately not matched: it is the same shape
	// as every `object.property` in the source, so matching it flagged the codebase, not a leak.
	test("passes a bare dotted host with no separator after it", () => {
		const result = runGuardOn("expect(result.exitCode).toBe(0)\n");
		expect(result.exitCode).toBe(0);
	});

	test("fails a repository name that merely starts with an allowlisted one", () => {
		const result = runGuardOn(`Cloned ${lookalikeRepo}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("nextup-mirror");
	});

	// The whole URL is one token, so an allowlisted issue URL carrying a second host in its query
	// must still fail. Accepting by prefix passed this, which is why prefix acceptance was removed.
	test("fails an allowlisted issue URL with a private host in its query string", () => {
		const result = runGuardOn(`Filed at ${nestedHostInQuery}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	// Standards identifiers share the tracker-key shape the guard used to match, and this is the
	// prose a repo about tickets, timestamps and lockfile hashes actually writes. Matching them
	// made the guard fire on benign documentation, which is what gets an allowlist rubber-stamped.
	test("passes standards and specification identifiers", () => {
		const result = runGuardOn(
			"ADR-0003 uses ISO-8601 timestamps, SHA-256 integrity, UTF-8, RFC-3986, CVE-2024-3094, AES-256-GCM.\n",
		);
		expect(result.exitCode).toBe(0);
	});

	// A dependency specifier is not an identifier. Before the host was required to be dotted
	// with a letters-only final label, every lockfile entry was flagged.
	test("passes a package version specifier", () => {
		const result = runGuardOn('"typescript@5.9.3", "checkout@v4"\n');
		expect(result.exitCode).toBe(0);
	});
});
