import { describe, expect, test } from "bun:test";
import { defaultRunner } from "./runner";

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
});

describe("a redirected git environment", () => {
	function withEnv(name: string, value: string, work: () => void): void {
		const before = process.env[name];
		process.env[name] = value;
		try {
			work();
		} finally {
			if (before === undefined) delete process.env[name];
			else process.env[name] = before;
		}
	}

	// Measured against `git -C <intended> worktree list`: these two make git answer about another repository
	// while every answer stays self-consistent, so nothing downstream can notice. `GIT_WORK_TREE`,
	// `GIT_INDEX_FILE`, `GIT_NAMESPACE` and `GIT_CEILING_DIRECTORIES` left it alone.
	for (const name of ["GIT_DIR", "GIT_COMMON_DIR"]) {
		test(`refuses to run anything while ${name} is set`, () => {
			withEnv(name, "/somewhere/else/.git", () => {
				expect(() => defaultRunner(["git", "--version"])).toThrow(new RegExp(name));
			});
		});
	}

	test("says what to do about it, not only that it happened", () => {
		withEnv("GIT_DIR", "/somewhere/else/.git", () => {
			expect(() => defaultRunner(["git", "--version"])).toThrow(/unset/);
		});
	});

	test("ignores a variable it measured as harmless, rather than refusing every GIT_ name", () => {
		withEnv("GIT_WORK_TREE", "/somewhere/else", () => {
			expect(defaultRunner(["git", "--version"]).code).toBe(0);
		});
	});

	test("treats an empty value as unset, which is what an unexported shell variable leaves behind", () => {
		withEnv("GIT_DIR", "", () => {
			expect(defaultRunner(["git", "--version"]).code).toBe(0);
		});
	});
});

