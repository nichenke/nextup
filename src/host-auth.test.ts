import { describe, expect, test } from "bun:test";
import { hasJiraAuth, isAuthenticatedHost } from "./host-auth";
import { fakeRunner, routedRunner } from "./test-support";

describe("isAuthenticatedHost", () => {
	test("true when gh reports the host authenticated", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(true);
	});

	test("true when glab reports the host authenticated", () => {
		const runner = fakeRunner({ code: 0, stdout: "", stderr: "" });
		expect(isAuthenticatedHost("gitlab", "example.com", runner)).toBe(true);
	});

	test("false when the CLI reports the host is not authenticated", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "not logged in\n" });
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(false);
	});

	test("queries gh with --hostname rather than text-matching free-form status output", () => {
		const runner = routedRunner({
			"gh auth status --hostname example.com": { code: 0, stdout: "", stderr: "" },
		});
		expect(isAuthenticatedHost("github", "example.com", runner)).toBe(true);
		expect(isAuthenticatedHost("github", "other-host.test", runner)).toBe(false);
	});

	test("queries glab with --hostname rather than text-matching free-form status output", () => {
		const runner = routedRunner({
			"glab auth status --hostname example.com": { code: 0, stdout: "", stderr: "" },
		});
		expect(isAuthenticatedHost("gitlab", "example.com", runner)).toBe(true);
		expect(isAuthenticatedHost("gitlab", "other-host.test", runner)).toBe(false);
	});

	test("strips a port before querying, since the CLIs report and match on bare hostnames", () => {
		const runner = routedRunner({
			"gh auth status --hostname example.com": { code: 0, stdout: "", stderr: "" },
		});
		expect(isAuthenticatedHost("github", "example.com:8080", runner)).toBe(true);
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
