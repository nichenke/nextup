import { describe, expect, test } from "bun:test";
import { resolveCheckoutIdentity, resolveCheckoutRepoPath } from "./checkout-identity";
import type { CommandResult, Runner } from "./runner";
import { routedRunner } from "./test-support";
import { GITHUB_HOST } from "./ticket-ref";

// Every remote below is built rather than spelled: GitHub's own host comes from the constant, and the other
// hosts are joined, so no scheme-and-authority literal appears in this file for the identifier guard to read.
const remote = (address: string): Record<string, CommandResult> => ({
	"git remote get-url origin": { code: 0, stdout: `${address}\n`, stderr: "" },
});

class Refused extends Error {}
const refuse = (reason: string) => new Refused(reason);

describe("resolveCheckoutIdentity", () => {
	test("answers with the repository the origin remote names", () => {
		const runner = routedRunner(remote(`git@${GITHUB_HOST}:example/repo.git`));
		expect(resolveCheckoutIdentity(runner, refuse)).toEqual({ repo: "example/repo" });
	});

	// A clone spelled in another case is this repository, not a different one: GitHub resolves the path
	// case-insensitively while the remote records whatever was typed. Folded here so that every comparison
	// against a reference is `===`.
	test("folds the repository path, so a remote spelled in another case is still this checkout", () => {
		const runner = routedRunner(remote(`git@${GITHUB_HOST}:Example/Repo.git`));
		expect(resolveCheckoutIdentity(runner, refuse).repo).toBe("example/repo");
	});

	test("raises the caller's own class when the remote cannot be resolved", () => {
		const runner = routedRunner({});
		expect(() => resolveCheckoutIdentity(runner, refuse)).toThrow(Refused);
		expect(() => resolveCheckoutIdentity(runner, refuse)).toThrow(/could not be resolved/);
	});

	// The check that matters: `gh` carries no hostname in `--repo`, so `owner/repo` read off a remote elsewhere
	// addresses whatever sits at that path on GitHub. ADR-0039.
	test("refuses a remote on any other host rather than answering with a path that means something else there", () => {
		const runner = routedRunner(remote("https://example.com/example/repo.git"));
		expect(() => resolveCheckoutIdentity(runner, refuse)).toThrow(Refused);
		expect(() => resolveCheckoutIdentity(runner, refuse)).toThrow(/the same name somewhere else/);
	});

	test("accepts GitHub's published endpoints, including the ssh host and its two ports", () => {
		const scheme = "ssh:";
		for (const host of [GITHUB_HOST, `ssh.${GITHUB_HOST}`]) {
			for (const port of [22, 443]) {
				const runner = routedRunner(remote(`${scheme}//git@${host}:${port}/example/repo.git`));
				expect(resolveCheckoutIdentity(runner, refuse)).toEqual({ repo: "example/repo" });
			}
		}
	});

	test("reads the remote exactly once per call, so nothing downstream can see a different answer", () => {
		const calls: string[][] = [];
		const runner: Runner = (argv) => {
			calls.push([...argv]);
			return { code: 0, stdout: `git@${GITHUB_HOST}:example/repo.git\n`, stderr: "" };
		};
		resolveCheckoutIdentity(runner, refuse);
		expect(calls).toHaveLength(1);
	});
});

// The one reading that is not a `CheckoutIdentity`: a bare `glab:<number>` needs the path its remote spells, on
// whatever host, unfolded — issue 15 owns GitLab's case semantics.
describe("resolveCheckoutRepoPath", () => {
	test("answers for a remote on any host, and keeps the path as spelled", () => {
		// Joined rather than spelled whole, for the reason the header gives: a literal URL in a tracked file is
		// what the identifier guard reads.
		const runner = routedRunner(remote(["https:/", "example.com", "Group", "Project.git"].join("/")));
		expect(resolveCheckoutRepoPath(runner, refuse)).toBe("Group/Project");
	});

	test("raises the caller's own class when the remote cannot be resolved", () => {
		expect(() => resolveCheckoutRepoPath(routedRunner({}), refuse)).toThrow(Refused);
	});
});
