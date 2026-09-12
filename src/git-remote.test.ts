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

	test("skips an empty url, which git drops from a remote rather than fetching from", () => {
		const runner = fakeRunner({ code: 0, stdout: originStdout("") + originStdout(HTTPS_REMOTE), stderr: "" });
		expect(resolveOriginRemote(runner, "/repo")?.repo ?? null).toBe("example/repo");
	});
});

describe("checkoutOriginUrl", () => {
	test("takes a value this checkout's own config supplies", () => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE))).toBe(HTTPS_REMOTE);
	});

	test("takes a value a worktree configures for itself", () => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE, "worktree"))).toBe(HTTPS_REMOTE);
	});

	test.each(["global", "system", "command"])("leaves a %s value alone, since this checkout did not ask for it", (scope) => {
		expect(checkoutOriginUrl(originStdout(HTTPS_REMOTE, scope))).toBeNull();
	});

	test("reaches past an ambient value to the one this checkout configures", () => {
		expect(checkoutOriginUrl(originStdout(NESTED_REMOTE, "global") + originStdout(HTTPS_REMOTE))).toBe(HTTPS_REMOTE);
	});

	test("answers nothing for output carrying no scope at all", () => {
		expect(checkoutOriginUrl(`${HTTPS_REMOTE}\0`)).toBeNull();
	});

	/**
	 * The vector `-z` exists for: a value git prints verbatim, whose own text spells a record separator and a
	 * contract scope. Line-delimited, this read attributed the forged half to the checkout — which is the
	 * ambient redirect the whole decision refuses, coming back in through the parser. ADR-0042.
	 */
	test("keeps a forged scope inside a value rather than reading it as a record", () => {
		const forged = `${HTTPS_REMOTE}\nlocal\t${NESTED_REMOTE}`;
		expect(checkoutOriginUrl(originStdout(forged, "global"))).toBeNull();
	});
});
