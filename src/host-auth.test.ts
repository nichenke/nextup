import { describe, expect, test } from "bun:test";
import type { CommandResult, Exec } from "./exec";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";

function fakeExec(result: CommandResult): Exec {
	return () => result;
}

describe("isAuthenticatedHost", () => {
	test("recognises a host present in gh auth status output", () => {
		const exec = fakeExec({ code: 0, stdout: "", stderr: "✓ Logged in to example.com as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com", exec)).toBe(true);
	});

	test("recognises a host present in glab auth status output", () => {
		const exec = fakeExec({ code: 0, stdout: "example.com\n  ✓ Logged in as octocat\n", stderr: "" });
		expect(isAuthenticatedHost("gitlab", "example.com", exec)).toBe(true);
	});

	test("refuses a host absent from the auth status output", () => {
		const exec = fakeExec({ code: 0, stdout: "", stderr: "✓ Logged in to other-host.test as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com", exec)).toBe(false);
	});

	test("refuses when the CLI reports no session at all", () => {
		const exec = fakeExec({ code: 1, stdout: "", stderr: "You are not logged into any accounts\n" });
		expect(isAuthenticatedHost("github", "example.com", exec)).toBe(false);
	});

	test("refuses a host that is only a substring of an authenticated host", () => {
		const exec = fakeExec({ code: 0, stdout: "", stderr: "✓ Logged in to github.com as octocat\n" });
		expect(isAuthenticatedHost("github", "hub.com", exec)).toBe(false);
	});

	test("refuses a host for which the authenticated host is only a substring", () => {
		const exec = fakeExec({ code: 0, stdout: "", stderr: "✓ Logged in to example.com as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com.evil.test", exec)).toBe(false);
	});
});

describe("hasJiraAuth", () => {
	test("true when the jira CLI resolves the current user", () => {
		const exec = fakeExec({ code: 0, stdout: "octocat\n", stderr: "" });
		expect(hasJiraAuth(exec)).toBe(true);
	});

	test("false when the jira CLI has no session", () => {
		const exec = fakeExec({ code: 1, stdout: "", stderr: "no config file found\n" });
		expect(hasJiraAuth(exec)).toBe(false);
	});
});
