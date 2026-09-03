import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-identifiers.sh");

// The disallowed fixtures below are assembled at runtime rather than written as
// literals: a literal would sit in a tracked file and the guard would flag its own
// test, which is the one file that has to contain a failing case.
const disallowedHostUrl = "https://" + "internal." + "corp" + ".test";
const disallowedKey = "WOR" + "K-1234";
const disallowedShortKey = "Q" + "Z-9";

// Splitting mid-URL is not enough for the owner cases: a fragment that ends partway through
// the hostname still carries a scheme, so the host check flags the truncated host. The scheme
// is what gets split instead. (Writing that example out literally here also tripped it.)
const scheme = "ht" + "tps://";
const disallowedOwnerUrl = `${scheme}github.com/private-org/repo`;
const disallowedOwnerRef = "private-org/re" + "po#7";
const disallowedScpRemote = "git@github.com:" + "private-org/repo.git";
const disallowedSshUrlRemote = "ssh://git@" + "internal.corp.test/group/repo.git";

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
	test("passes a file using only allowlisted identifiers", () => {
		const result = runGuardOn("See https://example.com/issues/1 and TEST-42.\n");
		expect(result.exitCode).toBe(0);
	});

	test("passes an allowlisted host carrying a port", () => {
		const result = runGuardOn("Served at https://localhost:3000/health\n");
		expect(result.exitCode).toBe(0);
	});

	test("fails on a host outside the allowlist, naming it", () => {
		const result = runGuardOn(`Ticket at ${disallowedHostUrl}/issues/7\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	test("fails on an issue-key prefix outside the allowlist, naming it", () => {
		const result = runGuardOn(`Blocked by ${disallowedKey}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(disallowedKey);
	});

	test("fails on a two-letter prefix, the shortest the pattern accepts", () => {
		const result = runGuardOn(`Blocked by ${disallowedShortKey}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(disallowedShortKey);
	});

	// Regression: an earlier key pattern allowed digits in the prefix, which made it match
	// a substring of a bracket character class and fail on the guard's own source.
	test("passes a file containing a regex character class", () => {
		const result = runGuardOn("Pattern: [A-Z][A-Z0-9]{1,9}-[0-9]+\n");
		expect(result.exitCode).toBe(0);
	});

	test("passes a code-host URL owned by an allowlisted owner", () => {
		const result = runGuardOn("See https://github.com/nichenke/nextup\n");
		expect(result.exitCode).toBe(0);
	});

	// The host allowlist alone cannot catch these: github.com is allowed, and the owner
	// that identifies a private organisation lives in the path.
	test("fails a code-host URL whose owner is not allowlisted", () => {
		const result = runGuardOn(`Upstream: ${disallowedOwnerUrl}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	test("fails a cross-repo issue reference whose owner is not allowlisted", () => {
		const result = runGuardOn(`Tracked in ${disallowedOwnerRef}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	// Git remotes are usually SSH, and neither the host nor the owner check above sees them:
	// there is no http scheme to anchor on. Remotes are what this tool's fixtures will hold,
	// since it discovers a repository from its remote.
	test("passes an allowlisted SSH remote in scp form", () => {
		const result = runGuardOn("origin git@github.com:nichenke/nextup.git\n");
		expect(result.exitCode).toBe(0);
	});

	test("fails an SSH remote in scp form whose owner is not allowlisted", () => {
		const result = runGuardOn(`origin ${disallowedScpRemote}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("private-org");
	});

	test("fails an ssh:// remote whose host is not allowlisted", () => {
		const result = runGuardOn(`origin ${disallowedSshUrlRemote}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("internal.corp.test");
	});

	// The SSH pattern is user@host-shaped, so it could have swallowed email addresses. It
	// requires a trailing owner segment precisely so that it does not.
	test("passes a bare email address, which is not a remote", () => {
		const result = runGuardOn("Contact noreply@anthropic.com for details\n");
		expect(result.exitCode).toBe(0);
	});
});
