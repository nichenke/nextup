import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./runner";
import { routedRunner } from "./test-support";
import { type TicketRef, TicketRefError, compareTicketRefs, formatTicketRef, resolveTicketRef } from "./ticket-ref";

const GIT_REMOTE = { "git remote get-url origin": { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" } };
const GIT_REMOTE_NO_OWNER = { "git remote get-url origin": { code: 0, stdout: "https://example.com/justrepo.git\n", stderr: "" } };
const GH_AUTHED = { "gh auth status --hostname example.com --active": { code: 0, stdout: "", stderr: "" } };
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

	test("gh: absolute form rejects an empty leading segment", () => {
		expect(() => resolveTicketRef("gh:/repo#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("gh: absolute form rejects an empty trailing segment", () => {
		expect(() => resolveTicketRef("gh:owner/#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("gh: absolute form rejects more than two segments, since GitHub has no subgroups", () => {
		expect(() => resolveTicketRef("gh:owner/sub/repo#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("glab: absolute form rejects an empty middle segment", () => {
		expect(() => resolveTicketRef("glab:group//repo#1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("gh: relative form rejects a git remote that doesn't resolve to owner/repo", () => {
		expect(() => resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE_NO_OWNER) })).toThrow(TicketRefError);
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

	test("md: short form normalizes a zero-padded number to the same key as its bare form", () => {
		expect(resolveTicketRef("md:07").key).toBe("7");
		expect(resolveTicketRef("md:7").key).toBe("7");
	});

	test("md: short form rejects a ticket number of zero, which no effort numbers from", () => {
		expect(() => resolveTicketRef("md:0")).toThrow(TicketRefError);
		expect(() => resolveTicketRef("md:00")).toThrow(TicketRefError);
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

	test("a GitLab issue URL rejects a repo with no namespace segment", () => {
		expect(() =>
			resolveTicketRef("https://example.com/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) }),
		).toThrow(TicketRefError);
	});

	test("a GitLab issue URL rejects an empty middle segment", () => {
		expect(() =>
			resolveTicketRef("https://example.com/group//project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) }),
		).toThrow(TicketRefError);
	});

	test("a redirect-style query string is never read as part of the repo path", () => {
		expect(() =>
			resolveTicketRef("https://example.com/?next=/group/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) }),
		).toThrow(TicketRefError);
	});

	test("a userinfo prefix on the URL authority is unsupported and fails the host-auth check, even with a real account authenticated", () => {
		expect(() =>
			resolveTicketRef("https://alice@example.com/group/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) }),
		).toThrow(TicketRefError);
	});

	test("a Jira browse URL resolves when a Jira session exists", () => {
		const ref = resolveTicketRef("https://example.com/browse/TEST-42", { runner: routedRunner(JIRA_AUTHED) });
		expect(ref).toEqual({ tracker: "jira", repo: null, host: "example.com", key: "TEST-42" });
	});

	test("a Jira browse URL under a context path resolves the same as one at the root", () => {
		const ref = resolveTicketRef("https://example.com/jira/browse/TEST-42", { runner: routedRunner(JIRA_AUTHED) });
		expect(ref).toEqual({ tracker: "jira", repo: null, host: "example.com", key: "TEST-42" });
	});

	test("an uppercase hostname normalizes to lowercase and still matches lowercase auth state", () => {
		const ref = resolveTicketRef("https://EXAMPLE.com/group/project/-/issues/1", { runner: routedRunner(GLAB_AUTHED) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/project", host: "example.com", key: "1" });
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

	test("a single-segment GitLab path is never misclassified as GitHub, and is rejected as an invalid repo shape rather than a host-auth failure", () => {
		// If GENERIC_ISSUES_URL's negative lookahead ever failed to exclude "/-/issues/", this
		// would instead resolve as tracker "github" (or throw a host-auth error), not this one.
		expect(() => resolveTicketRef("https://example.com/group/-/issues/1", { runner: routedRunner(GLAB_AUTHED) })).toThrow(
			/valid namespace\/project path/,
		);
	});

	test("a legacy (no /-/) GitLab URL with a subgroup resolves as gitlab without needing disambiguation", () => {
		const ref = resolveTicketRef("https://example.com/group/subgroup/project/issues/1", {
			runner: routedRunner(GLAB_AUTHED),
		});
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/subgroup/project", host: "example.com", key: "1" });
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

describe("formatTicketRef", () => {
	test("writes the short form each tracker's scheme accepts", () => {
		expect(formatTicketRef({ tracker: "markdown", repo: null, host: null, key: "7" })).toBe("md:7");
		expect(formatTicketRef({ tracker: "github", repo: "example/repo", host: null, key: "1" })).toBe(
			"gh:example/repo#1",
		);
		expect(formatTicketRef({ tracker: "gitlab", repo: "group/project", host: null, key: "8" })).toBe(
			"glab:group/project#8",
		);
		expect(formatTicketRef({ tracker: "jira", repo: null, host: null, key: "TEST-42" })).toBe("jira:TEST-42");
	});

	test("omits a known host, which no short form can carry", () => {
		expect(formatTicketRef({ tracker: "github", repo: "example/repo", host: "example.com", key: "1" })).toBe(
			"gh:example/repo#1",
		);
	});
});

describe("compareTicketRefs", () => {
	const md = (key: string): TicketRef => ({ tracker: "markdown", repo: null, host: null, key });

	function sorted(refs: TicketRef[]): string[] {
		return [...refs].sort(compareTicketRefs).map(formatTicketRef);
	}

	test("orders a ticket number numerically rather than lexicographically", () => {
		expect(sorted([md("10"), md("9"), md("100")])).toEqual(["md:9", "md:10", "md:100"]);
	});

	test("orders a jira key's numeric tail numerically, and its project part as text", () => {
		const jira = (key: string): TicketRef => ({ tracker: "jira", repo: null, host: null, key });
		expect(sorted([jira("TEST-10"), jira("TEST-9"), jira("APP-9")])).toEqual([
			"jira:APP-9",
			"jira:TEST-9",
			"jira:TEST-10",
		]);
	});

	test("separates two projects that share a ticket number", () => {
		const gh = (repo: string): TicketRef => ({ tracker: "github", repo, host: null, key: "1" });
		expect(compareTicketRefs(gh("example/repo"), gh("group/project"))).toBeLessThan(0);
	});

	test("separates two hosts that share a repository and a number", () => {
		const at = (host: string | null): TicketRef => ({ tracker: "github", repo: "example/repo", host, key: "1" });
		expect(compareTicketRefs(at(null), at("example.com"))).toBeLessThan(0);
		expect(compareTicketRefs(at("example.com"), at(null))).toBeGreaterThan(0);
	});

	test("separates two trackers, by the tracker name", () => {
		expect(compareTicketRefs({ tracker: "jira", repo: null, host: null, key: "1" }, md("1"))).toBeLessThan(0);
	});

	// Nothing may tie except a reference identical in every part, or the ladder's terminal rung stops
	// being terminal and hands the decision to the order the tickets arrived in.
	test("ties only on a reference identical in every part", () => {
		expect(compareTicketRefs(md("7"), md("7"))).toBe(0);
		expect(compareTicketRefs(md("07"), md("7"))).toBeLessThan(0);
	});
});
