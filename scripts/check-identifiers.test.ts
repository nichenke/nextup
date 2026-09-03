import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-identifiers.sh");

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

// A prefix must not vouch for a longer name that merely starts with it.
const lookalikeRepo = "https://github.com/nichenke/nextup" + "-mirror/x";

function runGuardOn(contents: string) {
	const dir = mkdtempSync(join(tmpdir(), "nextup-guard-"));
	writeFileSync(join(dir, "fixture.md"), contents);
	for (const cmd of [
		["git", "init", "-q"],
		["git", "add", "fixture.md"],
	]) {
		const setup = spawnSync({ cmd, cwd: dir });
		if (setup.exitCode !== 0) {
			throw new Error(`fixture setup failed: ${cmd.join(" ")}`);
		}
	}
	return spawnSync({ cmd: ["bash", script], cwd: dir });
}

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

	test("passes any issue or pull-request URL under this repository", () => {
		const result = runGuardOn(
			"See https://github.com/nichenke/nextup/issues/19 and https://github.com/nichenke/nextup/pull/1\n",
		);
		expect(result.exitCode).toBe(0);
	});

	test("fails a repository name that merely starts with an allowlisted prefix", () => {
		const result = runGuardOn(`Cloned ${lookalikeRepo}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("nextup-mirror");
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
