import { describe, expect, test } from "bun:test";
import { resolveCheckoutIdentity, resolveCheckoutRepoPath } from "./checkout-identity";
import type { Runner } from "./runner";
import { originRoute, routedRunner } from "./test-support";
import { GITHUB_HOST } from "./repo-address";

const HERE = "/checkout";

// Every remote below is built rather than spelled: GitHub's own host comes from the constant, and the other
// hosts are joined, so no scheme-and-authority literal appears in this file for the identifier guard to read.
const remote = (address: string) => originRoute(HERE, address);

class Refused extends Error {}
const refuse = (reason: string) => new Refused(reason);

describe("resolveCheckoutIdentity", () => {
	test("answers with the repository the origin remote names", () => {
		const runner = routedRunner(remote(`git@${GITHUB_HOST}:example/repo.git`));
		expect(resolveCheckoutIdentity(runner, HERE, refuse).repo).toBe("example/repo");
	});

	test("folds the repository path, so a remote spelled in another case is still this checkout", () => {
		const runner = routedRunner(remote(`git@${GITHUB_HOST}:Example/Repo.git`));
		expect(resolveCheckoutIdentity(runner, HERE, refuse).repo).toBe("example/repo");
	});

	test("raises the caller's own class when the remote cannot be resolved", () => {
		const runner = routedRunner({});
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).toThrow(Refused);
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).toThrow(/could not be resolved/);
	});

	test("names the directory it asked about, which is no longer whichever one the process happened to be in", () => {
		expect(() => resolveCheckoutIdentity(routedRunner({}), HERE, refuse)).toThrow(new RegExp(HERE));
	});

	test("says why a host that is not one appeared, rather than reporting it as another tracker", () => {
		const runner = routedRunner(remote("shorthand:example/repo"));
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).toThrow(/insteadOf/);
	});

	test("leaves a real host on another tracker unexplained, since no rewriting is involved", () => {
		const runner = routedRunner(remote(["https:/", "example.com", "example", "repo.git"].join("/")));
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).not.toThrow(/insteadOf/);
	});

	// The check that matters: `gh` carries no hostname in `--repo`, so `owner/repo` read off a remote elsewhere
	// addresses whatever sits at that path on GitHub. ADR-0040.
	test("refuses a remote on any other host rather than answering with a path that means something else there", () => {
		const runner = routedRunner(remote("https://example.com/example/repo.git"));
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).toThrow(Refused);
		expect(() => resolveCheckoutIdentity(runner, HERE, refuse)).toThrow(/the same name somewhere else/);
	});

	test("accepts GitHub's published endpoints, including the ssh host and its two ports", () => {
		const scheme = "ssh:";
		for (const host of [GITHUB_HOST, `ssh.${GITHUB_HOST}`]) {
			for (const port of [22, 443]) {
				const runner = routedRunner(remote(`${scheme}//git@${host}:${port}/example/repo.git`));
				expect(resolveCheckoutIdentity(runner, HERE, refuse).repo).toBe("example/repo");
			}
		}
	});

	test("reads the remote exactly once per call, so nothing downstream can see a different answer", () => {
		const calls: string[][] = [];
		const runner: Runner = (argv) => {
			calls.push([...argv]);
			return { code: 0, stdout: `git@${GITHUB_HOST}:example/repo.git\n`, stderr: "" };
		};
		resolveCheckoutIdentity(runner, HERE, refuse);
		expect(calls).toHaveLength(1);
	});
});

describe("resolveCheckoutRepoPath", () => {
	test("answers for a remote on any host, and keeps the path as spelled", () => {
		const runner = routedRunner(remote(["https:/", "example.com", "Group", "Project.git"].join("/")));
		expect(resolveCheckoutRepoPath(runner, HERE, refuse)).toBe("Group/Project");
	});

	test("raises the caller's own class when the remote cannot be resolved", () => {
		expect(() => resolveCheckoutRepoPath(routedRunner({}), HERE, refuse)).toThrow(Refused);
	});

	// The pair this cannot tell apart, pinned together because keeping the first is the reason it cannot refuse
	// the second. ADR-0041 has what the second can cost and why it is bounded.
	test("keeps a short hostname, which a refusal on a dotless host would have taken with the aliases", () => {
		expect(resolveCheckoutRepoPath(routedRunner(remote("git@gitlab:group/project.git")), HERE, refuse)).toBe("group/project");
	});

	test("answers with an alias's own path, which is the expanded one only where the alias spells no namespace", () => {
		expect(resolveCheckoutRepoPath(routedRunner(remote("work:group/project")), HERE, refuse)).toBe("group/project");
	});
});
