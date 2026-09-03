import { describe, expect, test } from "bun:test";
import type { CommandResult, Exec } from "./exec";
import { TicketRefError, resolveTicketRef } from "./ticket-ref";

function fakeExec(routes: Record<string, CommandResult>): Exec {
	return (argv) => routes[argv.join(" ")] ?? { code: 1, stdout: "", stderr: "" };
}

const GIT_REMOTE = { "git remote get-url origin": { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" } };
const GH_AUTHED = { "gh auth status": { code: 0, stdout: "", stderr: "✓ Logged in to example.com as octocat\n" } };
const GLAB_AUTHED = { "glab auth status": { code: 0, stdout: "example.com\n  ✓ Logged in as octocat\n", stderr: "" } };
const JIRA_AUTHED = { "jira me": { code: 0, stdout: "octocat\n", stderr: "" } };

describe("resolveTicketRef: short forms", () => {
	test("gh: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("gh:1", { exec: fakeExec(GIT_REMOTE) });
		expect(ref).toEqual({ tracker: "github", repo: "example/repo", host: null, key: "1" });
	});

	test("gh: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("gh:1", { exec: fakeExec(GIT_REMOTE) });
		const absolute = resolveTicketRef("gh:example/repo#1", { exec: fakeExec({}) });
		expect(absolute).toEqual(relative);
	});

	test("gh: relative form fails loudly with no git remote", () => {
		expect(() => resolveTicketRef("gh:1", { exec: fakeExec({}) })).toThrow(TicketRefError);
	});

	test("glab: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("glab:8", { exec: fakeExec(GIT_REMOTE) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "example/repo", host: null, key: "8" });
	});

	test("glab: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("glab:8", { exec: fakeExec(GIT_REMOTE) });
		const absolute = resolveTicketRef("glab:example/repo#8", { exec: fakeExec({}) });
		expect(absolute).toEqual(relative);
	});

	test("glab: absolute form accepts a nested namespace", () => {
		const ref = resolveTicketRef("glab:group/project#8", { exec: fakeExec({}) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: null, key: "8" });
	});

	test("jira: short form parses the key verbatim", () => {
		const ref = resolveTicketRef("jira:TEST-42");
		expect(ref).toEqual({ tracker: "jira", repo: null, host: null, key: "TEST-42" });
	});

	test("jira: short form rejects a key with no project prefix", () => {
		expect(() => resolveTicketRef("jira:42")).toThrow(TicketRefError);
	});

	test("md: short form parses a bare ticket number", () => {
		const ref = resolveTicketRef("md:42");
		expect(ref).toEqual({ tracker: "markdown", repo: null, host: null, key: "42" });
	});

	test("md: short form rejects a non-numeric ticket reference", () => {
		expect(() => resolveTicketRef("md:not-a-number")).toThrow(TicketRefError);
	});

	test("an unrecognised reference fails loudly rather than guessing", () => {
		expect(() => resolveTicketRef("bitbucket:1")).toThrow(TicketRefError);
	});
});

describe("resolveTicketRef: pasted URLs", () => {
	test("a GitHub issue URL resolves when the host is authenticated", () => {
		const ref = resolveTicketRef("https://example.com/example/repo/issues/1", { exec: fakeExec(GH_AUTHED) });
		expect(ref).toEqual({ tracker: "github", repo: "example/repo", host: "example.com", key: "1" });
	});

	test("a GitLab issue URL resolves by /-/issues/ shape, not the GitHub /issues/ shape", () => {
		const ref = resolveTicketRef("https://example.com/group/project/-/issues/1", { exec: fakeExec(GLAB_AUTHED) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: "example.com", key: "1" });
	});

	test("a Jira browse URL resolves when a Jira session exists", () => {
		const ref = resolveTicketRef("https://example.com/browse/TEST-42", { exec: fakeExec(JIRA_AUTHED) });
		expect(ref).toEqual({ tracker: "jira", repo: null, host: "example.com", key: "TEST-42" });
	});

	test("a GitHub issue URL for a host nothing is authenticated to fails loudly", () => {
		expect(() =>
			resolveTicketRef("https://example.com/example/repo/issues/1", { exec: fakeExec({}) }),
		).toThrow(TicketRefError);
	});

	test("a GitLab issue URL for a host nothing is authenticated to fails loudly", () => {
		expect(() =>
			resolveTicketRef("https://example.com/group/project/-/issues/1", { exec: fakeExec({}) }),
		).toThrow(TicketRefError);
	});

	test("a Jira browse URL fails loudly with no authenticated Jira session", () => {
		expect(() => resolveTicketRef("https://example.com/browse/TEST-42", { exec: fakeExec({}) })).toThrow(
			TicketRefError,
		);
	});

	test("a URL matching none of the three shapes fails loudly", () => {
		expect(() => resolveTicketRef("https://example.com/example/repo/pull/1", { exec: fakeExec({}) })).toThrow(
			TicketRefError,
		);
	});
});
