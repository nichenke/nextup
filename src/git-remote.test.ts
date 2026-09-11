import { describe, expect, test } from "bun:test";
import { parseRemote, resolveOriginRemote } from "./git-remote";
import { fakeRunner } from "./test-support";

const HTTPS_REMOTE = "https://example.com/example/repo.git";
const HTTPS_REMOTE_NO_SUFFIX = "https://example.com/example/repo";
const SSH_REMOTE = "ssh://git@example.com/example/repo.git";
const SCP_REMOTE = "git@example.com:example/repo.git";
const SCP_REMOTE_NO_USER = "example.com:example/repo.git";
const NESTED_REMOTE = "https://example.com/group/subgroup/project.git";
const TRAILING_SLASH_REMOTE = "https://example.com/example/repo.git/";

const repoPathOf = (remote: string): string | null => parseRemote(remote)?.repo ?? null;

describe("parseRemote", () => {
	test("parses an https remote", () => {
		expect(repoPathOf(HTTPS_REMOTE)).toBe("example/repo");
	});

	test("parses an https remote with no .git suffix", () => {
		expect(repoPathOf(HTTPS_REMOTE_NO_SUFFIX)).toBe("example/repo");
	});

	test("parses a ssh:// remote with an embedded user", () => {
		expect(repoPathOf(SSH_REMOTE)).toBe("example/repo");
	});

	test("parses an scp-form remote", () => {
		expect(repoPathOf(SCP_REMOTE)).toBe("example/repo");
	});

	test("parses an scp-form remote with no explicit user, per git's [user@]host:path grammar", () => {
		expect(repoPathOf(SCP_REMOTE_NO_USER)).toBe("example/repo");
	});

	test("parses a nested namespace path", () => {
		expect(repoPathOf(NESTED_REMOTE)).toBe("group/subgroup/project");
	});

	test("strips a trailing slash that follows the .git suffix", () => {
		expect(repoPathOf(TRAILING_SLASH_REMOTE)).toBe("example/repo");
	});

	test("returns null for an unparseable remote", () => {
		expect(repoPathOf("not-a-remote")).toBeNull();
	});
});

describe("resolveOriginRemote", () => {
	test("resolves the repo from a successful git remote lookup", () => {
		const runner = fakeRunner({ code: 0, stdout: `${HTTPS_REMOTE}\n`, stderr: "" });
		expect(resolveOriginRemote(runner)?.repo ?? null).toBe("example/repo");
	});

	test("returns null when there is no origin remote", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "fatal: No such remote 'origin'\n" });
		expect(resolveOriginRemote(runner)?.repo ?? null).toBeNull();
	});
});
