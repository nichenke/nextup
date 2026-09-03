import { describe, expect, test } from "bun:test";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";
import { fakeRunner } from "./test-support";

describe("isAuthenticatedHost", () => {
	test("recognises a host present in gh auth status output", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "✓ Logged in to example.com as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(true);
	});

	test("recognises a host present in glab auth status output", () => {
		const runner = fakeRunner({ code: 0, stdout: "example.com\n  ✓ Logged in as octocat\n", stderr: "" });
		expect(isAuthenticatedHost("gitlab", "example.com", runner)).toBe(true);
	});

	test("refuses a host absent from the auth status output", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "✓ Logged in to other-host.test as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(false);
	});

	test("refuses when the CLI reports no session at all", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "You are not logged into any accounts\n" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(false);
	});

	test("refuses a host that is only a substring of an authenticated host", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "✓ Logged in to github.com as octocat\n" });
		expect(isAuthenticatedHost("github", "hub.com", runner)).toBe(false);
	});

	test("refuses a host for which the authenticated host is only a substring", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "✓ Logged in to example.com as octocat\n" });
		expect(isAuthenticatedHost("github", "example.com.evil.test", runner)).toBe(false);
	});

	test("refuses a host when the status call itself failed, even if the host string appears in its output", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "X Failed to log in to example.com: token expired\n" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(false);
	});
});

describe("hasJiraAuth", () => {
	test("true when the jira CLI resolves the current user", () => {
		const runner = fakeRunner({ code: 0, stdout: "octocat\n", stderr: "" });
		expect(hasJiraAuth(runner)).toBe(true);
	});

	test("false when the jira CLI has no session", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "no config file found\n" });
		expect(hasJiraAuth(runner)).toBe(false);
	});
});
