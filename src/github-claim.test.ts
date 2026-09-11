import { describe, expect, test } from "bun:test";
import type { CheckoutIdentity } from "./checkout-identity";
import { githubClaimCommand } from "./command-builders";
import { GitHubClaimError, claimGitHubTicket } from "./github-claim";
import type { Runner } from "./runner";
import { fakeRunner, githubRecording, replayRunner, respondingRunner } from "./test-support";
import { GITHUB_TEST_TREE } from "./test-tree";
import { type GitHubTicketRef, formatTicketRef, githubTicketRef } from "./ticket-ref";

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
 * The issue a capture named, for the failing writes, whose stdout is empty and so cannot say. Safe to read off
 * the argv here, unlike `WRITE_TARGET`, because the failing captures test classification and wording rather than
 * what was asked.
 */
function claimedIssueIn(argv: readonly string[]): string {
	const separator = argv.indexOf("--");
	const key = separator === -1 ? undefined : argv[separator + 1];
	if (key === undefined) throw new Error(`${argv.join(" ")} names no issue after a "--" separator`);
	return key;
}

function githubRef(key: string = WRITE_TARGET, repo: string = REPO): GitHubTicketRef {
	return githubTicketRef(repo, key);
}

/** The checkout every claim below is standing in: the test tree, which is where its references live. */
const HERE: CheckoutIdentity = { repo: REPO.toLowerCase() };

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
		claimGitHubTicket({ runner: tracker.runner, ref: githubRef(), checkout: HERE });
		expect(tracker.calls).toEqual([[...githubClaimCommand({ repo: REPO, key: WRITE_TARGET })]]);
	});

	test("accepts a reference a pasted URL produced, which carries no host to disagree about", () => {
		const runner = replayRunner([CLAIM]);
		expect(() => claimGitHubTicket({ runner, ref: githubRef(), checkout: HERE })).not.toThrow();
	});
});

describe("claimGitHubTicket, when the write fails", () => {
	const DEFECT = githubRecording("claim-defect");
	const defectRef = githubRef(claimedIssueIn(DEFECT.argv));

	// The outage capture's argv names a host this refuses outright, so its response is replayed without its argv
	// — the same reason `read-outage` is answered this way.
	const outageRunner: Runner = respondingRunner(githubRecording("claim-outage"));

	test("aborts on a defect, saying a retry will not help", () => {
		expect(() => claimGitHubTicket({ runner: replayRunner([DEFECT]), ref: defectRef, checkout: HERE })).toThrow(GitHubClaimError);
		expect(() => claimGitHubTicket({ runner: replayRunner([DEFECT]), ref: defectRef, checkout: HERE })).toThrow(/retry will not fix/);
	});

	test("aborts on an outage too, and only the message tells the two apart", () => {
		expect(() => claimGitHubTicket({ runner: outageRunner, ref: githubRef(), checkout: HERE })).toThrow(GitHubClaimError);
		expect(() => claimGitHubTicket({ runner: outageRunner, ref: githubRef(), checkout: HERE })).toThrow(/could not be reached/);
	});

	test("carries the failure's own words, so the message is not only our reading of it", () => {
		expect(() => claimGitHubTicket({ runner: outageRunner, ref: githubRef(), checkout: HERE })).toThrow(/error connecting to/);
	});

	// A literal rather than a built pattern: the repository path is interpolated from the tree spec, and a `.` in
	// a renamed tree would become a wildcard that passes on a message naming a different repository.
	test("names the ticket it failed to claim, since the run stops here and nothing downstream will", () => {
		try {
			claimGitHubTicket({ runner: outageRunner, ref: githubRef(), checkout: HERE });
			throw new Error("the claim was expected to abort");
		} catch (cause) {
			expect(cause).toBeInstanceOf(GitHubClaimError);
			expect((cause as GitHubClaimError).message).toContain(formatTicketRef(githubRef()));
		}
	});

	// A non-zero exit that wrote its diagnostic to stdout instead. The message is the operator's whole evidence
	// here, since the run halts with a worktree already made, so it must not abort on a bare colon.
	test("falls back to stdout when a failure wrote nothing to stderr", () => {
		const runner = fakeRunner({ code: 1, stdout: "could not write to that repository\n", stderr: "" });
		expect(() => claimGitHubTicket({ runner, ref: githubRef(), checkout: HERE })).toThrow(/could not write to that repository/);
	});

	// Nothing is left to quote, so the code has to be the evidence rather than the message trailing off after its
	// colon. Exit 1 rather than a made-up code: that is what a command exiting non-zero in silence really gives.
	test("names the exit code when a failure wrote nothing at all", () => {
		const runner = fakeRunner({ code: 1, stdout: "", stderr: "" });
		expect(() => claimGitHubTicket({ runner, ref: githubRef(), checkout: HERE })).toThrow(/no output, exit 1/);
	});

	test("collapses a multi-line failure, so one abort is one line", () => {
		try {
			claimGitHubTicket({ runner: outageRunner, ref: githubRef(), checkout: HERE });
			throw new Error("the claim was expected to abort");
		} catch (cause) {
			expect(cause).toBeInstanceOf(GitHubClaimError);
			expect((cause as GitHubClaimError).message).not.toContain("\n");
		}
	});
});

describe("claimGitHubTicket, before it writes anything", () => {
	// The one refusal left here. The four this block used to hold — another tracker, no repository, a path that is
	// not owner-and-repository, and a host that is not GitHub's — are shapes `GitHubTicketRef` cannot hold, so
	// there is no value to hand this function that would trip them. ADR-0038 records the collapse and
	// `ticket-ref.test.ts` is where each refusal moved to; the padded-key and flag-shaped-key pair moved there too.
	test("refuses a ticket in another repository, rather than claiming there while the work happens here", () => {
		expect(() =>
			claimGitHubTicket({ runner: unreachable, ref: githubRef(WRITE_TARGET, "example/elsewhere"), checkout: HERE }),
		).toThrow(GitHubClaimError);
	});

	// Both sides were folded at construction, so a clone spelled in another case is this repository rather than a
	// different one — the fold that used to happen at this comparison.
	test("accepts a reference whose repository was spelled in another case", () => {
		const runner = replayRunner([CLAIM]);
		expect(() => claimGitHubTicket({ runner, ref: githubRef(WRITE_TARGET, REPO.toUpperCase()), checkout: HERE })).not.toThrow();
	});
});
