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
});
