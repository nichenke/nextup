import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./runner";
import { routedRunner } from "./test-support";
import { TicketRefError, resolveTicketRef } from "./ticket-ref";

const GIT_REMOTE = { "git remote get-url origin": { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" } };
const GH_AUTHED = { "gh auth status --hostname example.com": { code: 0, stdout: "", stderr: "" } };
const GLAB_AUTHED = { "glab auth status --hostname example.com": { code: 0, stdout: "", stderr: "" } };
const JIRA_AUTHED = { "jira me": { code: 0, stdout: "octocat\n", stderr: "" } };

function merge(...routes: Record<string, CommandResult>[]): Record<string, CommandResult> {
	return Object.assign({}, ...routes);
}

describe("resolveTicketRef: short forms", () => {
	test("gh: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE) });
		expect(ref).toEqual({ tracker: "github", repo: "example/repo", host: null, key: "1" });
	});

	test("gh: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE) });
		const absolute = resolveTicketRef("gh:example/repo#1", { runner: routedRunner({}) });
		expect(absolute).toEqual(relative);
	});

	test("gh: relative form fails loudly with no git remote", () => {
		expect(() => resolveTicketRef("gh:1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("glab: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("glab:8", { runner: routedRunner(GIT_REMOTE) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "example/repo", host: null, key: "8" });
	});

	test("glab: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("glab:8", { runner: routedRunner(GIT_REMOTE) });
		const absolute = resolveTicketRef("glab:example/repo#8", { runner: routedRunner({}) });
		expect(absolute).toEqual(relative);
	});

	test("glab: absolute form accepts a nested namespace", () => {
		const ref = resolveTicketRef("glab:group/project#8", { runner: routedRunner({}) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: null, key: "8" });
	});

	test("gh: absolute form rejects a repo with no owner segment", () => {
		expect(() => resolveTicketRef("gh:myrepo#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("glab: absolute form rejects a repo with no namespace segment", () => {
		expect(() => resolveTicketRef("glab:myrepo#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
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
	test("a GitLab issue URL resolves by /-/issues/ shape when the host is authenticated to glab", () => {
		const ref = resolveTicketRef("https://example.com/group/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: "example.com", key: "1" });
	});

	test("a GitLab issue URL for a host nothing is authenticated to fails loudly", () => {
		expect(() =>
			resolveTicketRef("https://example.com/group/project/-/issues/1", { runner: routedRunner({}) }),
		).toThrow(TicketRefError);
	});

	test("a Jira browse URL resolves when a Jira session exists", () => {
		const ref = resolveTicketRef("https://example.com/browse/TEST-42", { runner: routedRunner(JIRA_AUTHED) });
		expect(ref).toEqual({ tracker: "jira", repo: null, host: "example.com", key: "TEST-42" });
	});

	test("a Jira browse URL fails loudly with no authenticated Jira session", () => {
		expect(() => resolveTicketRef("https://example.com/browse/TEST-42", { runner: routedRunner({}) })).toThrow(
			TicketRefError,
		);
	});

	test("a URL matching none of the three shapes fails loudly", () => {
		expect(() => resolveTicketRef("https://example.com/example/repo/pull/1", { runner: routedRunner({}) })).toThrow(
			TicketRefError,
		);
	});

	test("an uppercase scheme resolves the same as lowercase", () => {
		const ref = resolveTicketRef("HTTPS://example.com/group/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: "example.com", key: "1" });
	});

	test("a flat-namespace GitLab URL is never misclassified as GitHub, regardless of check order", () => {
		const ref = resolveTicketRef("https://example.com/group/-/issues/1", { runner: routedRunner(GLAB_AUTHED) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group", host: "example.com", key: "1" });
	});

	describe("the two-segment /issues/ shape, shared by GitHub and older self-hosted GitLab", () => {
		test("resolves as github when only gh is authenticated to the host", () => {
			const ref = resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner(GH_AUTHED) });
			expect(ref).toEqual({ tracker: "github", repo: "example/repo", host: "example.com", key: "1" });
		});

		test("resolves as gitlab when only glab is authenticated to the host", () => {
			const ref = resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner(GLAB_AUTHED) });
			expect(ref).toEqual({ tracker: "gitlab", repo: "example/repo", host: "example.com", key: "1" });
		});

		test("fails loudly when the host is authenticated to both gh and glab", () => {
			expect(() =>
				resolveTicketRef("https://example.com/example/repo/issues/1", {
					runner: routedRunner(merge(GH_AUTHED, GLAB_AUTHED)),
				}),
			).toThrow(TicketRefError);
		});

		test("fails loudly when the host is authenticated to neither", () => {
			expect(() =>
				resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner({}) }),
			).toThrow(TicketRefError);
		});
	});
});
