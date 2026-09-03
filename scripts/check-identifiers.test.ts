import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-identifiers.sh");

// Fixtures the guard must reject are assembled at runtime, because this file is itself tracked
// and scanned. The split falls immediately after a scheme's colon, or before a host's first dot,
// so that neither fragment is a token in its own right: a scheme needs `://` to match, and the
// @ form needs a dotted host.
const unknownHttpsUrl = "https:" + "//internal.corp.test/x";
const unknownSshUrl = "ssh:" + "//internal.corp.test/group/repo.git";
const unknownGitUrl = "git:" + "//internal.corp.test/group/repo.git";
const unknownScpRemote = "git@internal" + ".corp.test:group/repo.git";
const unknownEmail = "person@internal" + ".corp.test";
const unknownKey = "WOR" + "K-1234";
const unknownRef = "private-org/repo" + "#7";

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
		const result = runGuardOn("See https://example.com/issues/1 and TEST-42\n");
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

	test("fails an unrecognised project key", () => {
		const result = runGuardOn(`Blocked by ${unknownKey}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(unknownKey);
	});

	test("fails an unrecognised cross-repo issue reference", () => {
		const result = runGuardOn(`Tracked in ${unknownRef}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	// Markup travels with a token when it is grepped out of prose, and is not part of it.
	test("passes an allowlisted URL ending a sentence", () => {
		const result = runGuardOn("Filed at https://example.com/issues/1.\n");
		expect(result.exitCode).toBe(0);
	});

	test("passes an allowlisted URL inside a markdown link", () => {
		const result = runGuardOn("See [the ticket](https://example.com/issues/1)\n");
		expect(result.exitCode).toBe(0);
	});

	// A dependency specifier is not an identifier. Before the host was required to be dotted
	// with a letters-only final label, every lockfile entry was flagged.
	test("passes a package version specifier", () => {
		const result = runGuardOn('"typescript@5.9.3", "checkout@v4"\n');
		expect(result.exitCode).toBe(0);
	});

	// Regression: an earlier key pattern allowed digits in the prefix, which made it match a
	// substring of a bracket character class and fail on the guard's own source.
	test("passes a file containing a regex character class", () => {
		const result = runGuardOn("Pattern: [A-Z][A-Z0-9]{1,9}-[0-9]+\n");
		expect(result.exitCode).toBe(0);
	});
});
