import { describe, expect, test } from "bun:test";
import { CommandBuilderError, githubClaimCommand } from "./command-builders";
import { GitHubClaimError, claimGitHubTicket } from "./github-claim";
import type { Runner } from "./runner";
import { githubRecording, replayRunner, respondingRunner } from "./test-support";
import { GITHUB_TEST_TREE } from "./test-tree";
import { GITHUB_HOST, type TicketRef } from "./ticket-ref";

const REPO = GITHUB_TEST_TREE.repo;

const CLAIM = githubRecording("claim");

/**
 * The number `write-target` carried when the claim was captured, taken from the address `gh` printed. A rebuilt
 * tree renumbers, so it cannot be written down here — ADR-0023.
 *
 * Deliberately not read off the recording's own argv, which would make `replayRunner` vacuous: it answers only
 * the argv it captured, and that refusal is what tests the claim's issued argv against the captured one. A key
 * taken from that same argv would match by construction.
 */
const WRITE_TARGET = claimedIssue(CLAIM.stdout);

function claimedIssue(stdout: string): string {
	const number = /\/(\d+)$/.exec(stdout.trim())?.[1];
	if (number === undefined) throw new Error(`the claim recording's stdout names no issue: ${JSON.stringify(stdout)}`);
	return number;
}

/**
 * The issue a capture named, for the failing writes, whose stdout is empty and so cannot say.
 *
 * This does read the recording's own argv, so a test built on it cannot also test what was asked — the failing
 * captures are used for classification and wording only. `WRITE_TARGET` is the one that has to come from
 * elsewhere, because the success case is where the issued argv is checked against the captured one.
 */
function claimedIssueIn(argv: readonly string[]): string {
	const separator = argv.indexOf("--");
	const key = separator === -1 ? undefined : argv[separator + 1];
	if (key === undefined) throw new Error(`${argv.join(" ")} names no issue after a "--" separator`);
	return key;
}

function githubRef(overrides: Partial<TicketRef> = {}): TicketRef {
	return { tracker: "github", repo: REPO, host: null, key: WRITE_TARGET, ...overrides };
}

/** A runner keeping every call it was handed, so a claim can be asserted to be one write and no read. */
function counted(runner: Runner): { readonly runner: Runner; readonly calls: readonly string[][] } {
	const calls: string[][] = [];
	return { runner: (argv) => (calls.push(argv), runner(argv)), calls };
}

/** Fails the test if anything reaches it, for the refusals that must land before a call goes out. */
const unreachable: Runner = (argv) => {
	throw new Error(`the claim issued ${argv.join(" ")} when it should have refused first`);
};

describe("claimGitHubTicket, against the captured write", () => {
	// The call count is the assertion, not an incidental: ADR-0018 has why a read-back could decide nothing.
	test("is one write and no read, so no call can be mistaken for arbitration", () => {
		const tracker = counted(replayRunner([CLAIM]));
		claimGitHubTicket({ runner: tracker.runner, ref: githubRef() });
		expect(tracker.calls).toEqual([[...githubClaimCommand({ repo: REPO, key: WRITE_TARGET })]]);
	});

	test("accepts a reference naming GitHub's own host, which a pasted URL carries", () => {
		const runner = replayRunner([CLAIM]);
		expect(() => claimGitHubTicket({ runner, ref: githubRef({ host: GITHUB_HOST }) })).not.toThrow();
	});
});

describe("claimGitHubTicket, when the write fails", () => {
	const DEFECT = githubRecording("claim-defect");
	const defectRef = githubRef({ key: claimedIssueIn(DEFECT.argv) });

	// The outage capture's argv names a host this refuses outright, so its response is replayed without its argv
	// — the same reason `read-outage` is answered this way.
	const OUTAGE = githubRecording("claim-outage");
	const outageRunner = (): Runner => respondingRunner(OUTAGE);

	test("aborts on a defect, saying a retry will not help", () => {
		expect(() => claimGitHubTicket({ runner: replayRunner([DEFECT]), ref: defectRef })).toThrow(GitHubClaimError);
		expect(() => claimGitHubTicket({ runner: replayRunner([DEFECT]), ref: defectRef })).toThrow(/retry will not fix/);
	});

	test("aborts on an outage too, and only the message tells the two apart", () => {
		expect(() => claimGitHubTicket({ runner: outageRunner(), ref: githubRef() })).toThrow(GitHubClaimError);
		expect(() => claimGitHubTicket({ runner: outageRunner(), ref: githubRef() })).toThrow(/could not be reached/);
	});

	test("carries the failure's own words, so the message is not only our reading of it", () => {
		expect(() => claimGitHubTicket({ runner: outageRunner(), ref: githubRef() })).toThrow(/error connecting to/);
	});

	test("names the ticket it failed to claim, since the run stops here and nothing downstream will", () => {
		expect(() => claimGitHubTicket({ runner: outageRunner(), ref: githubRef() })).toThrow(
			new RegExp(`gh:${REPO}#${WRITE_TARGET}`),
		);
	});

	test("collapses a multi-line failure, so one abort is one line", () => {
		try {
			claimGitHubTicket({ runner: outageRunner(), ref: githubRef() });
			throw new Error("the claim was expected to abort");
		} catch (cause) {
			expect(cause).toBeInstanceOf(GitHubClaimError);
			expect((cause as GitHubClaimError).message).not.toContain("\n");
		}
	});
});

describe("claimGitHubTicket, before it writes anything", () => {
	test("refuses a reference belonging to another tracker", () => {
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ tracker: "gitlab" }) })).toThrow(
			GitHubClaimError,
		);
	});

	test("refuses a reference carrying no repository, which an issue number means nothing without", () => {
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ repo: null }) })).toThrow(/repository/);
	});

	test("refuses a repository path that is not one owner and one repository", () => {
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ repo: "group/sub/project" }) })).toThrow(
			GitHubClaimError,
		);
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ repo: "lonely" }) })).toThrow(GitHubClaimError);
	});

	test("refuses a reference whose host is not GitHub's, rather than writing to that path on GitHub", () => {
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ host: "github.example.test" }) })).toThrow(
			GitHubClaimError,
		);
	});

	test("does not reach the CLI with a key the CLI would read as a flag", () => {
		expect(() => claimGitHubTicket({ runner: unreachable, ref: githubRef({ key: "--help" }) })).toThrow(
			CommandBuilderError,
		);
	});
});
