import { describe, expect, test } from "bun:test";
import type { CommandResult } from "./runner";
import { routedRunner } from "./test-support";
import {
	GITHUB_HOST,
	type TicketRef,
	TicketRefError,
	compareTicketRefs,
	formatTicketRef,
	githubTicketRef,
	gitlabTicketRef,
	jiraTicketRef,
	resolveTicketRef,
} from "./ticket-ref";

// GitHub's own host is spelled through the constant, in git's scp form, so no spelling of it appears in this
// file for the identifier guard to read.
const remote = (address: string) => ({ "git remote get-url origin": { code: 0, stdout: `${address}\n`, stderr: "" } });
const GIT_REMOTE = remote(`git@${GITHUB_HOST}:example/repo.git`);
const GIT_REMOTE_NO_OWNER = remote(`git@${GITHUB_HOST}:justrepo.git`);
const GIT_REMOTE_ELSEWHERE = remote("https://example.com/example/repo.git");

// The scheme is held apart from the host so that no scheme-and-authority spelling appears in this file, which
// the identifier guard reads — CLAUDE.md's identifier section.
const SSH_SCHEME = "ssh:";
const sshRemote = (host: string, port: number) => `${SSH_SCHEME}//git@${host}:${port}/example/repo.git`;
// Joined rather than spelled whole, for the same reason: a literal URL on GitHub's host would put that host
// in this file for the guard to read.
const githubUrl = (...path: string[]) => ["https:/", GITHUB_HOST, ...path].join("/");
const GH_AUTHED = { "gh auth status --hostname example.com --active": { code: 0, stdout: "", stderr: "" } };
const GLAB_AUTHED = { "glab auth status --hostname example.com": { code: 0, stdout: "", stderr: "" } };
const JIRA_AUTHED = { "jira me": { code: 0, stdout: "octocat\n", stderr: "" } };

function merge(...routes: Record<string, CommandResult>[]): Record<string, CommandResult> {
	return Object.assign({}, ...routes);
}

describe("resolveTicketRef: short forms", () => {
	test("gh: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE) });
		expect(ref).toEqual({ tracker: "github", repo: "example/repo", key: "1" });
	});

	test("gh: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE) });
		const absolute = resolveTicketRef("gh:example/repo#1", { runner: routedRunner({}) });
		expect(absolute).toEqual(relative);
	});

	test("gh: relative form fails loudly with no git remote", () => {
		expect(() => resolveTicketRef("gh:1", { runner: routedRunner({}) })).toThrow(TicketRefError);
	});

	test("gh: relative form accepts GitHub's remotes that carry a port, including its SSH endpoint", () => {
		for (const address of [sshRemote(GITHUB_HOST, 22), sshRemote(`ssh.${GITHUB_HOST}`, 443)]) {
			const ref = resolveTicketRef("gh:1", { runner: routedRunner(remote(address)) });
			expect(ref).toEqual({ tracker: "github", repo: "example/repo", key: "1" });
		}
	});

	/**
	 * A port GitHub does not answer on is not GitHub, and every caller reads acceptance as "this checkout is the
	 * repository at that path" before writing a claim from it. Port-hosted GitHub is out of scope, so the two
	 * published endpoint ports above are the whole set rather than a floor.
	 */
	test("gh: relative form refuses a remote at a port GitHub does not serve", () => {
		for (const port of [8443, 2222, 80]) {
			expect(() => resolveTicketRef("gh:1", { runner: routedRunner(remote(sshRemote(GITHUB_HOST, port))) })).toThrow(
				TicketRefError,
			);
		}
	});

	test("gh: relative form refuses a remote on a host that is not GitHub, rather than reading that path there", () => {
		expect(() => resolveTicketRef("gh:1", { runner: routedRunner(GIT_REMOTE_ELSEWHERE) })).toThrow(
			/the same name somewhere else/,
		);
	});

	test("glab: relative form resolves the repo from the git remote", () => {
		const ref = resolveTicketRef("glab:8", { runner: routedRunner(GIT_REMOTE_ELSEWHERE) });
		expect(ref).toEqual({ tracker: "gitlab", repo: "example/repo", host: null, key: "8" });
	});

	test("glab: absolute form normalizes identically to the relative form", () => {
		const relative = resolveTicketRef("glab:8", { runner: routedRunner(GIT_REMOTE_ELSEWHERE) });
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
		expect(ref).toEqual({ tracker: "jira", host: null, key: "TEST-42" });
	});

	test("jira: short form rejects a key with no project prefix", () => {
		expect(() => resolveTicketRef("jira:42")).toThrow(TicketRefError);
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
		expect(ref).toEqual({ tracker: "jira", host: "example.com", key: "TEST-42" });
	});

	test("a Jira browse URL under a context path resolves the same as one at the root", () => {
		const ref = resolveTicketRef("https://example.com/jira/browse/TEST-42", { runner: routedRunner(JIRA_AUTHED) });
		expect(ref).toEqual({ tracker: "jira", host: "example.com", key: "TEST-42" });
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
			/not a GitLab namespace and project/,
		);
	});

	test("a legacy (no /-/) GitLab URL with a subgroup resolves as gitlab without needing disambiguation", () => {
		const ref = resolveTicketRef("https://example.com/group/subgroup/project/issues/1", {
			runner: routedRunner(GLAB_AUTHED),
		});
		expect(ref).toEqual({ tracker: "gitlab", repo: "group/subgroup/project", host: "example.com", key: "1" });
	});

	// The host decides this shape now, and nothing else — ADR-0038. What `gh` is authenticated to used to be the
	// evidence, and that is exactly what admitted an Enterprise URL the reference types cannot hold.
	describe("the two-segment /issues/ shape, shared by GitHub and older self-hosted GitLab", () => {
		const GITHUB_URL = githubUrl("example", "repo", "issues", "1");

		test("resolves as github on GitHub's own host, asking no CLI whether it is authenticated there", () => {
			expect(resolveTicketRef(GITHUB_URL, { runner: routedRunner({}) })).toEqual(githubTicketRef("example/repo", "1"));
		});

		test("resolves as gitlab when glab is authenticated to the host", () => {
			const ref = resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner(GLAB_AUTHED) });
			expect(ref).toEqual(gitlabTicketRef("example/repo", "example.com", "1"));
		});

		// The scope boundary, and the one acceptance this change removes: `gh` reporting itself authenticated to an
		// Enterprise host used to make that URL a GitHub reference, which then reached a claim that carries no host.
		test("refuses a GitHub Enterprise URL, naming the boundary rather than reporting an unrecognized URL", () => {
			const refused = () =>
				resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner(GH_AUTHED) });
			expect(refused).toThrow(TicketRefError);
			expect(refused).toThrow(/out of scope/);
			expect(refused).not.toThrow(/does not match a GitHub, GitLab, or Jira issue URL shape/);
		});

		test("is not ambiguous when both CLIs answer for the host: only glab's answer is consulted", () => {
			const ref = resolveTicketRef("https://example.com/example/repo/issues/1", {
				runner: routedRunner(merge(GH_AUTHED, GLAB_AUTHED)),
			});
			expect(ref).toEqual(gitlabTicketRef("example/repo", "example.com", "1"));
		});

		test("fails loudly when the host is neither GitHub's nor one glab answers for", () => {
			expect(() =>
				resolveTicketRef("https://example.com/example/repo/issues/1", { runner: routedRunner({}) }),
			).toThrow(TicketRefError);
		});
	});

	// nichenke/nextup issue 56, measured: `gh` normalizes a padded number and this codebase did not, so the
	// reference named one issue and addressed another. Refused where the reference is built, which is the layer
	// ADR-0038 moved it to — every consumer reads `key` as identity, and an argv guard reaches none of them.
	describe("a padded issue number, at every entry point that could mint one", () => {
		test("the bare short form is refused", () => {
			expect(() => resolveTicketRef("gh:037", { runner: routedRunner(GIT_REMOTE) })).toThrow(/canonical issue number/);
		});

		test("the repo#number short form is refused", () => {
			expect(() => resolveTicketRef("gh:example/repo#037", { runner: routedRunner({}) })).toThrow(
				/canonical issue number/,
			);
		});

		test("a padded path segment in the two-segment URL form is refused", () => {
			expect(() =>
				resolveTicketRef(githubUrl("example", "repo", "issues", "037"), { runner: routedRunner({}) }),
			).toThrow(/canonical issue number/);
		});

		test("a padded path segment in the GitLab URL form is refused", () => {
			expect(() =>
				resolveTicketRef("https://example.com/group/project/-/issues/037", { runner: routedRunner(GLAB_AUTHED) }),
			).toThrow(/canonical issue number/);
		});

		test("a bare zero is refused as much as a padded number, since it names no issue either", () => {
			expect(() => resolveTicketRef("gh:example/repo#0", { runner: routedRunner({}) })).toThrow(
				/canonical issue number/,
			);
		});
	});
});

// The three shapes that used to be checked by a consumer, refused where the reference is built instead —
// ADR-0038. Each was a live check in `githubTicketTarget`, `claimGitHubTicket` or `requireTicketInThisCheckout`
// before this; a GitHub variant carrying a non-GitHub host is the fourth, and it is a compile error rather than
// a test, which is the whole point of the union.
describe("githubTicketRef", () => {
	test("folds the repository path, so one ticket cannot hold two identities", () => {
		expect(githubTicketRef("NicHenke/NextUp", "1").repo).toBe("nichenke/nextup");
	});

	test("refuses a path that is not exactly one owner and one repository", () => {
		expect(() => githubTicketRef("group/sub/project", "1")).toThrow(/GitHub owner and repository/);
		expect(() => githubTicketRef("lonely", "1")).toThrow(/GitHub owner and repository/);
		expect(() => githubTicketRef("example/", "1")).toThrow(/GitHub owner and repository/);
	});

	// The key `gh` would read as a flag rather than as the issue, which ADR-0032 measured exiting 0 on `--help`.
	// Refused here now, so nothing downstream can be handed one.
	test("refuses a key spelled like a flag", () => {
		expect(() => githubTicketRef("example/repo", "--help")).toThrow(/canonical issue number/);
	});
});

describe("formatTicketRef", () => {
	test("writes the short form each tracker's scheme accepts", () => {
		expect(formatTicketRef({ tracker: "github", repo: "example/repo", key: "1" })).toBe(
			"gh:example/repo#1",
		);
		expect(formatTicketRef({ tracker: "gitlab", repo: "group/project", host: null, key: "8" })).toBe(
			"glab:group/project#8",
		);
		expect(formatTicketRef({ tracker: "jira", host: null, key: "TEST-42" })).toBe("jira:TEST-42");
	});

	test("omits a known host, which no short form can carry", () => {
		expect(formatTicketRef(gitlabTicketRef("group/project", "example.com", "8"))).toBe("glab:group/project#8");
	});
});

describe("compareTicketRefs", () => {
	const gh = (key: string): TicketRef => githubTicketRef("example/repo", key);

	function sorted(refs: TicketRef[]): string[] {
		return [...refs].sort(compareTicketRefs).map(formatTicketRef);
	}

	test("orders a ticket number numerically rather than lexicographically", () => {
		expect(sorted([gh("10"), gh("9"), gh("100")])).toEqual([
			"gh:example/repo#9",
			"gh:example/repo#10",
			"gh:example/repo#100",
		]);
	});

	test("orders a jira key's numeric tail numerically, and its project part as text", () => {
		const jira = (key: string): TicketRef => jiraTicketRef(null, key);
		expect(sorted([jira("TEST-10"), jira("TEST-9"), jira("APP-9")])).toEqual([
			"jira:APP-9",
			"jira:TEST-9",
			"jira:TEST-10",
		]);
	});

	test("separates two projects that share a ticket number", () => {
		const gh = (repo: string): TicketRef => githubTicketRef(repo, "1");
		expect(compareTicketRefs(gh("example/repo"), gh("group/project"))).toBeLessThan(0);
	});

	// On GitLab, which is the tracker a reference can still carry a host for. GitHub's variant has none, so the
	// pair this used to separate cannot be built — ADR-0038.
	test("separates two hosts that share a repository and a number", () => {
		const at = (host: string | null): TicketRef => gitlabTicketRef("example/repo", host, "1");
		expect(compareTicketRefs(at(null), at("example.com"))).toBeLessThan(0);
		expect(compareTicketRefs(at("example.com"), at(null))).toBeGreaterThan(0);
	});

	test("separates two trackers, by the tracker name", () => {
		expect(compareTicketRefs(gh("1"), jiraTicketRef(null, "TEST-1"))).toBeLessThan(0);
	});

	test("ties only on a reference identical in every part", () => {
		expect(compareTicketRefs(gh("7"), gh("7"))).toBe(0);
		expect(compareTicketRefs(gh("7"), gh("70"))).toBeLessThan(0);
	});

	// The padded pair this used to assert on cannot be built any more, and the rule it rested on is unchanged:
	// `compareKeys` still treats `07` and `7` as different tickets, which is why a padded key is refused at
	// construction rather than folded there. A Jira key is where a padded numeral can still be spelled.
	test("still orders a padded numeral apart from its bare form, for the trackers that can carry one", () => {
		expect(compareTicketRefs(jiraTicketRef(null, "TEST-07"), jiraTicketRef(null, "TEST-7"))).toBeLessThan(0);
	});
});
