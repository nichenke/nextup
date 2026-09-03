import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { join } from "node:path";

const script = join(import.meta.dir, "debug-ref.ts");

function run(arg: string) {
	return spawnSync({ cmd: ["bun", script, arg] });
}

describe("debug-ref", () => {
	test("emits the normalized reference as JSON", () => {
		const result = run("jira:TEST-42");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			tracker: "jira",
			repo: null,
			host: null,
			key: "TEST-42",
		});
	});

	test("exits non-zero with a message for an unrecognised reference", () => {
		const result = run("bitbucket:1");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("bitbucket:1");
	});

	test("exits non-zero with a usage message when no argument is given", () => {
		const result = spawnSync({ cmd: ["bun", script] });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("usage");
	});
});
