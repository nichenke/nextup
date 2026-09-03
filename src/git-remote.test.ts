import { describe, expect, test } from "bun:test";
import type { CommandResult, Exec } from "./exec";
import { parseRepoPath, resolveRepoFromOrigin } from "./git-remote";

function fakeExec(result: CommandResult): Exec {
	return () => result;
}

const HTTPS_REMOTE = "https://example.com/example/repo.git";
const HTTPS_REMOTE_NO_SUFFIX = "https://example.com/example/repo";
const SSH_REMOTE = "ssh://git@example.com/example/repo.git";
const SCP_REMOTE = "git@example.com:example/repo.git";
const NESTED_REMOTE = "https://example.com/group/subgroup/project.git";

describe("parseRepoPath", () => {
	test("parses an https remote", () => {
		expect(parseRepoPath(HTTPS_REMOTE)).toBe("example/repo");
	});

	test("parses an https remote with no .git suffix", () => {
		expect(parseRepoPath(HTTPS_REMOTE_NO_SUFFIX)).toBe("example/repo");
	});

	test("parses a ssh:// remote with an embedded user", () => {
		expect(parseRepoPath(SSH_REMOTE)).toBe("example/repo");
	});

	test("parses an scp-form remote", () => {
		expect(parseRepoPath(SCP_REMOTE)).toBe("example/repo");
	});

	test("parses a nested namespace path", () => {
		expect(parseRepoPath(NESTED_REMOTE)).toBe("group/subgroup/project");
	});

	test("returns null for an unparseable remote", () => {
		expect(parseRepoPath("not-a-remote")).toBeNull();
	});
});

describe("resolveRepoFromOrigin", () => {
	test("resolves the repo from a successful git remote lookup", () => {
		const exec = fakeExec({ code: 0, stdout: `${HTTPS_REMOTE}\n`, stderr: "" });
		expect(resolveRepoFromOrigin(exec)).toBe("example/repo");
	});

	test("returns null when there is no origin remote", () => {
		const exec = fakeExec({ code: 1, stdout: "", stderr: "fatal: No such remote 'origin'\n" });
		expect(resolveRepoFromOrigin(exec)).toBeNull();
	});
});
