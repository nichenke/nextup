import { describe, expect, test } from "bun:test";
import { originRemoteCommand } from "./command-builders";
import { checkoutOriginUrl, parseRemote, resolveOriginRemote } from "./git-remote";
import type { Runner } from "./runner";
import { fakeRunner, originStdout } from "./test-support";

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
		const runner = fakeRunner({ code: 0, stdout: originStdout(HTTPS_REMOTE), stderr: "" });
		expect(resolveOriginRemote(runner, "/repo")?.repo ?? null).toBe("example/repo");
	});

	test("asks about the directory it was given rather than wherever the process is standing", () => {
		const asked: string[][] = [];
		const runner: Runner = (argv) => (asked.push([...argv]), { code: 0, stdout: originStdout(HTTPS_REMOTE), stderr: "" });
		resolveOriginRemote(runner, "/elsewhere");
		expect(asked).toEqual([[...originRemoteCommand("/elsewhere")]]);
	});

	test("returns null when there is no origin remote", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "fatal: No such remote 'origin'\n" });
		expect(resolveOriginRemote(runner, "/repo")?.repo ?? null).toBeNull();
	});

	test("takes the first of several urls, which is the one git fetches from", () => {
		const runner = fakeRunner({ code: 0, stdout: originStdout(HTTPS_REMOTE) + originStdout(NESTED_REMOTE), stderr: "" });
		expect(resolveOriginRemote(runner, "/repo")?.repo ?? null).toBe("example/repo");
	});

	test("returns null when the read succeeds with nothing to parse", () => {
		expect(resolveOriginRemote(fakeRunner({ code: 0, stdout: "\n", stderr: "" }), "/repo")).toBeNull();
	});

	// The empty value is refused rather than stepped over. Skipping it was tried and reverted: it answers with a
	// url the checkout does not fetch from, which is a wrong repository at exit 0 in exchange for a
	// configuration nobody has. ADR-0041.
	test("refuses an empty first url rather than answering with a later one", () => {
		const runner = fakeRunner({ code: 0, stdout: originStdout("") + originStdout(HTTPS_REMOTE), stderr: "" });
		expect(resolveOriginRemote(runner, "/repo")).toBeNull();
	});
});

describe("checkoutOriginUrl", () => {
	test("takes a value this checkout's own config supplies", () => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE))).toBe(HTTPS_REMOTE);
	});

	// A linked worktree's own `config.worktree`, which `--local` does not read — the shape that made reading one
	// file the wrong rule. ADR-0041.
	test("takes a value a worktree configures for itself", () => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE, "worktree"))).toBe(HTTPS_REMOTE);
	});

	test.each(["global", "system", "command"])("leaves a %s value alone, since this checkout did not ask for it", (scope) => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE, scope))).toBeNull();
	});

	test("reaches past an ambient value to the one this checkout configures", () => {
		expect(checkoutOriginUrl(originStdout(NESTED_REMOTE, "global") + originStdout(HTTPS_REMOTE))).toBe(HTTPS_REMOTE);
	});

	test("skips a line carrying no scope rather than reading it as a value", () => {
		expect(checkoutOriginUrl(`${HTTPS_REMOTE}\n`)).toBeNull();
	});

	test("keeps a value containing a tab, since only the first one delimits the scope", () => {
		expect(checkoutOriginUrl(originStdout("a\tb"))).toBe("a\tb");
	});
});
