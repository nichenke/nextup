import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, run } from "./cli";
import type { Runner } from "./runner";

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

function deps(cwd: string, confirm: CliDeps["confirm"] = terminal().confirm): CliDeps {
	return { cwd, runner: refuseToRun, confirm };
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "nextup-cli-"));
	roots.push(root);
	return root;
}

describe("run", () => {
	test("has no ticket-set source configured, and says so", () => {
		const result = run([], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no ticket-set source");
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], deps(tempRepo()));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--include");
		expect(result.stdout).toContain("--json");
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--include"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--include");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["gh:1"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("gh:1");
	});

	test("refuses a pattern the grammar does not accept", () => {
		const result = run(["--exclude", "way*er"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("way*er");
	});
});
