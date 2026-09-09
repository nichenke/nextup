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
	/**
	 * Runs `work` with every variable the guard reads set exactly as `overrides` says, and restored after.
	 *
	 * Both are cleared unless overridden, rather than only the one under test: these cases are about the
	 * ambient environment, so reading it is what they must not do. Left as it came, a `GIT_DIR` exported in
	 * the shell made the cases that expect success throw, and the suite failed for a reason no assertion
	 * named — met by a reviewer whose environment had one set.
	 */
	function withGitEnvironment(overrides: Readonly<Record<string, string>>, work: () => void): void {
		const names = ["GIT_DIR", "GIT_COMMON_DIR"];
		const before = new Map(names.map((name) => [name, process.env[name]]));
		for (const name of names) {
			const value = overrides[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		try {
			work();
		} finally {
			for (const [name, value] of before) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	for (const name of ["GIT_DIR", "GIT_COMMON_DIR"]) {
		test(`refuses to run anything while ${name} is set`, () => {
			withGitEnvironment({ [name]: "/somewhere/else/.git" }, () => {
				expect(() => defaultRunner(["git", "--version"])).toThrow(new RegExp(name));
			});
		});
	}

	test("says what to do about it, not only that it happened", () => {
		withGitEnvironment({ GIT_DIR: "/somewhere/else/.git" }, () => {
			expect(() => defaultRunner(["git", "--version"])).toThrow(/unset/);
		});
	});

	test("ignores a variable it measured as harmless, rather than refusing every GIT_ name", () => {
		withGitEnvironment({ GIT_WORK_TREE: "/somewhere/else" }, () => {
			expect(defaultRunner(["git", "--version"]).code).toBe(0);
		});
	});

	test("treats an empty value as unset, which is what an unexported shell variable leaves behind", () => {
		withGitEnvironment({ GIT_DIR: "" }, () => {
			expect(defaultRunner(["git", "--version"]).code).toBe(0);
		});
	});
});

