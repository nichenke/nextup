import { describe, expect, test } from "bun:test";
import { githubIssueListCommand } from "./command-builders";
import { deriveEffectiveBlockedness } from "./effective-blockedness";
import { GitHubAdapterError, readGitHubTicket, readGitHubTicketSet } from "./github-adapter";
import { readPriority } from "./priority";
import type { Runner } from "./runner";
import { answeringOrigin, githubRecording, recordedIssue, replayRunner, respondingRunner } from "./test-support";
import { GITHUB_TEST_TREE, openIssues, shapeTitle } from "./test-tree";
import { type Ticket, ticketId } from "./ticket";
import { GITHUB_HOST, type TicketRef } from "./ticket-ref";
import type { TicketRead, TicketSetRead } from "./ticket-set-read";

const REPO = GITHUB_TEST_TREE.repo;

/**
 * The tree's open issues, which is every row a read returns: the read asks for open tickets only, so a
 * closed shape is reachable here as a blocker on an edge and never as a ticket — ADR-0028.
 */
const OPEN_ISSUES = openIssues(GITHUB_TEST_TREE);

const WHOLE_TREE = OPEN_ISSUES.length;

/** The limit `ticket-set-truncated.json` was captured under, which `capture-github-recordings.ts` fixes. */
const TRUNCATING = 3;

// Built from the adapter's own accepted host, in git's scp form, so no spelling of it appears here for the
// identifier guard to read — and so these cannot drift from the host the adapter actually accepts.
const REMOTE = `git@${GITHUB_HOST}:example/repo.git`;
const NESTED_REMOTE = `git@${GITHUB_HOST}:group/subgroup/project.git`;
const ELSEWHERE_REMOTE = "https://example.com/example/repo.git";

/**
 * The ticket carrying one test-tree shape, found by the spec's title rather than by number, because a
 * rebuilt tree renumbers — ADR-0023.
 */
function shape(read: TicketSetRead, key: string): Ticket {
	const title = shapeTitle(GITHUB_TEST_TREE, key);
	const ticket = read.tickets.find((one) => one.title === title);
	if (ticket === undefined) throw new Error(`the read carries no ticket titled ${title}`);
	return ticket;
}

function blockedness(read: TicketSetRead, key: string): string {
	return deriveEffectiveBlockedness(ticketId(shape(read, key).ref), read.graph);
}

function wholeTree(): TicketSetRead {
	return readGitHubTicketSet({ repo: REPO, limit: WHOLE_TREE, runner: replayRunner([githubRecording("ticket-set")]) });
}

describe("readGitHubTicketSet, over the whole test tree", () => {
	test("normalizes every issue the tree holds, and reports itself untruncated", () => {
		const read = wholeTree();
		expect(read.tickets).toHaveLength(WHOLE_TREE);
		expect(read.truncated).toBe(false);
		expect(read.degraded).toEqual([]);
		expect([...read.tickets].map((one) => one.title).sort()).toEqual([...OPEN_ISSUES].map((one) => one.title).sort());
	});

	test("emits one reference form for the whole set, carrying the repository and no host", () => {
		for (const ticket of wholeTree().tickets) {
			expect(ticket.ref.tracker).toBe("github");
			expect(ticket.ref.repo).toBe(REPO);
			expect(ticket.ref.host).toBeNull();
			expect(ticket.ref.key).toMatch(/^\d+$/);
		}
	});

	test("hands back open tickets only, so a closed one is never a row to recommend", () => {
		const read = wholeTree();
		expect(shape(read, "open-blocker").state).toBe("open");
		for (const ticket of read.tickets) expect(ticket.state).toBe("open");
		expect(read.tickets.map((one) => one.title)).not.toContain(shapeTitle(GITHUB_TEST_TREE, "closed-blocker"));
	});

	test("reads the claim from the assignee, and leaves an unassigned ticket unclaimed", () => {
		const read = wholeTree();
		const claimed = shape(read, "claimed");
		expect(claimed.claim).not.toBeNull();
		expect(claimed.claim?.by).toMatch(/\S/);
		expect(shape(read, "write-target").claim).toBeNull();
		expect(read.tickets.filter((one) => one.claim !== null)).toHaveLength(1);
	});

	test("carries labels as names, so priority is derived from them and an unrankable one is reported", () => {
		const read = wholeTree();
		expect([...shape(read, "several-priorities").labels].sort()).toEqual(["P0", "P2", "priority: high"]);
		expect(readPriority(shape(read, "several-priorities").labels)).toEqual({ rank: 0, unread: ["priority: high"] });
		expect(readPriority(shape(read, "no-priority").labels)).toEqual({ rank: null, unread: [] });
		expect(readPriority(shape(read, "unread-priority").labels)).toEqual({ rank: null, unread: ["priority: high"] });
	});

	test("carries each ticket's own address, so a pick can be opened", () => {
		expect(shape(wholeTree(), "write-target").url).toMatch(/\/issues\/\d+$/);
	});
});

describe("the blocking graph the read seeds", () => {
	test("blocks a ticket two hops from its open blocker, so propagation traverses", () => {
		const read = wholeTree();
		expect(blockedness(read, "chain-tip")).toBe("blocked");
		expect(blockedness(read, "chain-middle")).toBe("blocked");
		expect(blockedness(read, "chain-base")).toBe("unblocked");
	});

	test("unblocks a ticket whose every blocker is closed, though its blocker total is above zero", () => {
		const read = wholeTree();
		const blockers = shape(read, "every-blocker-closed").blockers;
		expect(blockers).toHaveLength(1);
		// Derived from the closedness the edge carried, which is what ADR-0028 rests on.
		expect(read.tickets.map((one) => one.title)).not.toContain(shapeTitle(GITHUB_TEST_TREE, "closed-blocker"));
		expect(blockedness(read, "every-blocker-closed")).toBe("unblocked");
	});

	test("blocks on the open member of a mixed pair rather than on the count", () => {
		expect(blockedness(wholeTree(), "mixed-blockers")).toBe("blocked");
	});

	test("keeps a ticket the candidate filter would drop as a blocker of one it admits", () => {
		expect(blockedness(wholeTree(), "blocked-by-excluded")).toBe("blocked");
	});

	test("terminates on a dependency cycle rather than reading one of its members unblocked", () => {
		const read = wholeTree();
		expect(blockedness(read, "cycle-first")).toBe("blocked");
		expect(blockedness(read, "cycle-second")).toBe("blocked");
		expect(blockedness(read, "cycle-third")).toBe("blocked");
	});

	test("reads a confirmed absence of blockers as unblocked, not as unknown", () => {
		const read = wholeTree();
		expect(shape(read, "write-target").blockers).toEqual([]);
		expect(blockedness(read, "write-target")).toBe("unblocked");
	});
});

describe("a truncated read", () => {
	function truncated(): TicketSetRead {
		return readGitHubTicketSet({
			repo: REPO,
			limit: TRUNCATING,
			runner: replayRunner([githubRecording("ticket-set-truncated")]),
		});
	}

	test("reports itself truncated when the over-fetched row arrives, and hands back only the limit", () => {
		const read = truncated();
		expect(read.truncated).toBe(true);
		expect(read.tickets).toHaveLength(TRUNCATING);
	});

	test("still blocks on a blocker the read stopped short of, from the state its own edge carried", () => {
		const read = truncated();
		const blockers = shape(read, "cycle-third").blockers;
		if (blockers === "unknown") throw new Error("the truncated read was expected to carry this ticket's blocker");
		expect(blockers).toHaveLength(1);
		expect(read.tickets.some((one) => one.ref.key === blockers[0]?.key)).toBe(false);
		expect(blockedness(read, "cycle-third")).toBe("blocked");
	});
});

describe("a read that could not tell us about blocking", () => {
	test("degrades every ticket's blockers to unknown rather than to an empty list", () => {
		const read = readGitHubTicketSet({
			repo: REPO,
			limit: WHOLE_TREE,
			runner: respondingRunner(githubRecording("ticket-set-without-blockers")),
		});
		expect(read.tickets).toHaveLength(WHOLE_TREE);
		expect(read.degraded).toEqual([{ kind: "unreadable-blocking", tickets: WHOLE_TREE, of: WHOLE_TREE }]);
		for (const ticket of read.tickets) {
			expect(ticket.blockers).toBe("unknown");
		}
		expect(blockedness(read, "write-target")).toBe("unknown");
	});
});

describe("a read that failed", () => {
	test("flags an outage and continues, rather than presenting an empty tracker as a complete one", () => {
		const read = readGitHubTicketSet({
			repo: REPO,
			limit: WHOLE_TREE,
			runner: respondingRunner(githubRecording("read-outage")),
		});
		expect(read.tickets).toEqual([]);
		expect(read.truncated).toBe(true);
		expect(read.degraded).toHaveLength(1);
		expect(read.degraded[0]?.kind).toBe("outage");
	});

	// One line at construction rather than at a render boundary: `--json` carries this field raw, so a
	// newline surviving here reaches a consumer whatever the human rendering does about it.
	test("reports the outage detail as one line, though the tracker wrote several", () => {
		const read = readGitHubTicketSet({
			repo: REPO,
			limit: WHOLE_TREE,
			runner: () => ({ code: 1, stdout: "", stderr: "error connecting to somewhere.invalid\ncheck your connection\n" }),
		});
		const outage = read.degraded[0];
		if (outage?.kind !== "outage") throw new Error("the failed read was expected to report an outage");
		expect(outage.detail).toBe("error connecting to somewhere.invalid check your connection");
	});

	test("fails loud on a request that is itself wrong, rather than degrading past a defect", () => {
		const defect = githubRecording("read-defect");
		const repo = defect.argv[defect.argv.indexOf("--repo") + 1]!;
		expect(() =>
			readGitHubTicketSet({ repo, limit: WHOLE_TREE, runner: replayRunner([defect]) }),
		).toThrow(GitHubAdapterError);
	});
});

// The rows the two blocks below hand the read are built here rather than captured, and every one of them goes
// through `issueRow`, so what a row of this shape carries is stated once — a field the read starts requiring
// is one edit rather than three.
const INLINE_REPO = "example/repo";

function issueRow(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number: 1,
		title: "A ticket",
		state: "OPEN",
		assignees: [],
		labels: [],
		url: `${INLINE_REPO}/issues/1`,
		blockedBy: { nodes: [], totalCount: 0 },
		...fields,
	};
}

function closedRow(number: number): Record<string, unknown> {
	return issueRow({ number, state: "CLOSED", url: `${INLINE_REPO}/issues/${number}` });
}

function blockerNode(number: number, state: string): Record<string, unknown> {
	return { number, state, url: `${INLINE_REPO}/issues/${number}` };
}

function answering(stdout: string): TicketSetRead {
	return readGitHubTicketSet({ repo: INLINE_REPO, limit: 5, runner: () => ({ code: 0, stdout, stderr: "" }) });
}

function reading(...rows: readonly Record<string, unknown>[]): TicketSetRead {
	return answering(JSON.stringify(rows));
}

function blockednessOfFirst(read: TicketSetRead): string {
	return deriveEffectiveBlockedness(ticketId(read.tickets[0]!.ref), read.graph);
}

describe("a response the read cannot parse", () => {
	// These assert refusals of shapes no tracker emits, which is not the claim ADR-0019 governs.
	test("refuses a success carrying no JSON", () => {
		expect(() => answering("not json")).toThrow(/returned no JSON/);
	});

	test("refuses a success carrying something other than a list of issues", () => {
		expect(() => answering(`{"issues": []}`)).toThrow(/list of issues/);
	});

	/**
	 * No recording carries a closed row any more, because the query does not ask for one — so this is what
	 * holds the row-state path down. Without it, hard-coding every row open would pass the whole suite, and a
	 * genuinely closed row would then be accepted in silence.
	 *
	 * Checked on all three paths a row can take out of the read, because the narrowing ones are where a closed
	 * row used to survive: `select` sees only what is handed back, so a row held out for partial blocking or
	 * sliced off past the limit reached nobody, and the answer reported `closed not asked` over a response that
	 * held a closed ticket.
	 */
	test("refuses a closed row whichever way it would have left the read", () => {
		const closed = issueRow({ state: "CLOSED" });
		expect(() => reading(closed)).toThrow(/closed, though it asked for open tickets only/);

		const partial = issueRow({ state: "CLOSED", blockedBy: { nodes: [], totalCount: 2 } });
		expect(() => reading(partial)).toThrow(GitHubAdapterError);

		const pastTheLimit = () =>
			readGitHubTicketSet({
				repo: INLINE_REPO,
				limit: 1,
				runner: () => ({ code: 0, stdout: JSON.stringify([issueRow(), closedRow(2)]), stderr: "" }),
			});
		expect(pastTheLimit).toThrow(GitHubAdapterError);
	});

	/**
	 * The over-fetched row exists to reveal a cap, so its edges must not decide anything: they are one more
	 * dependent's copy of a third ticket's state, and letting them vote made the answer depend on a row nobody
	 * asked to consider. Flipping only the probe's edge used to flip which ticket was recommendable.
	 */
	test("keeps the over-fetched row's edges out of what it says about a blocker outside the read", () => {
		const blocked = (probeSays: string) => {
			const rows = [
				issueRow({ number: 1, url: `${INLINE_REPO}/issues/1`, blockedBy: { nodes: [blockerNode(99, "CLOSED")], totalCount: 1 } }),
				issueRow({ number: 2, url: `${INLINE_REPO}/issues/2` }),
				issueRow({ number: 3, url: `${INLINE_REPO}/issues/3`, blockedBy: { nodes: [blockerNode(99, probeSays)], totalCount: 1 } }),
			];
			const read = readGitHubTicketSet({
				repo: INLINE_REPO,
				limit: 2,
				runner: () => ({ code: 0, stdout: JSON.stringify(rows), stderr: "" }),
			});
			return { read, first: deriveEffectiveBlockedness(ticketId(read.tickets[0]!.ref), read.graph) };
		};

		for (const probeSays of ["CLOSED", "OPEN"]) {
			const { read, first } = blocked(probeSays);
			expect(read.truncated).toBe(true);
			expect(first).toBe("unblocked");
			expect(read.degraded).toEqual([]);
		}
	});

	/**
	 * `of` counts the rows the read considered, which is a wider population than the tickets it hands back: a
	 * row held out for partial blocking was read and is not a ticket. Asserted where the two differ, because
	 * everywhere else they are equal by construction and a narrower count would read as correct.
	 */
	test("counts unreadable blocking against the rows read, not against the tickets handed back", () => {
		const read = reading(
			issueRow({ blockedBy: undefined }),
			issueRow({ number: 2, url: `${INLINE_REPO}/issues/2`, blockedBy: { nodes: [], totalCount: 3 } }),
		);
		expect(read.tickets).toHaveLength(1);
		expect(read.degraded).toContainEqual({ kind: "unreadable-blocking", tickets: 1, of: 2 });
	});

	/**
	 * The sibling of the edge case above: the over-fetched row must not reach the answer through the degrade
	 * list either. Named on a `partial-blocking` line, a row nobody asked to consider becomes something a
	 * person is told was held back.
	 */
	test("keeps the over-fetched row out of what it reports as held back", () => {
		const read = readGitHubTicketSet({
			repo: INLINE_REPO,
			limit: 1,
			runner: () => ({
				code: 0,
				stdout: JSON.stringify([
					issueRow(),
					issueRow({ number: 2, url: `${INLINE_REPO}/issues/2`, blockedBy: { nodes: [], totalCount: 4 } }),
				]),
				stderr: "",
			}),
		});
		expect(read.truncated).toBe(true);
		expect(read.degraded).toEqual([]);
	});

	// As this adapter's own failure rather than as the plain `Error` `seedGraph` raises: a caller classifying on
	// the error type has nothing to recognise that one by, so it would arrive as a stack with no message.
	test("refuses a response holding one issue twice", () => {
		expect(() => reading(issueRow(), issueRow())).toThrow(GitHubAdapterError);
		expect(() => reading(issueRow(), issueRow())).toThrow(/more than one row for/);
	});

	test("refuses a row whose state is missing or is neither open nor closed", () => {
		expect(() => reading(issueRow({ state: undefined }))).toThrow(/state is not a string/);
		expect(() => reading(issueRow({ state: "MERGED" }))).toThrow(/neither open nor closed/);
	});

	test("refuses a row whose number, title or address it cannot read", () => {
		expect(() => reading(issueRow({ number: "1" }))).toThrow(/number is not a whole number/);
		expect(() => reading(issueRow({ title: null }))).toThrow(/title is not a string/);
		expect(() => reading(issueRow({ url: "" }))).toThrow(/url is empty/);
	});

	test("refuses a row whose assignees or labels are not lists, rather than reading them as absent", () => {
		expect(() => reading(issueRow({ assignees: undefined }))).toThrow(/claim cannot be read/);
		expect(() => reading(issueRow({ labels: "P0" }))).toThrow(/labels is not a list/);
	});

	test("refuses a blocking field present in a shape it cannot read", () => {
		expect(() => reading(issueRow({ blockedBy: { nodes: "one", totalCount: 1 } }))).toThrow(/not a list of blockers/);
		expect(() => reading(issueRow({ blockedBy: { nodes: [], totalCount: null } }))).toThrow(
			/totalCount is not a whole number/,
		);
	});

	test("refuses a blocker whose address names no owner and repository", () => {
		const nodes = [{ number: 2, state: "OPEN", url: "issues/2" }];
		expect(() => reading(issueRow({ blockedBy: { nodes, totalCount: 1 } }))).toThrow(/names no owner and repository/);
	});

	test("takes the repository before the last issue number, not the first", () => {
		const nodes = [{ number: 2, state: "OPEN", url: `outer/repo/issues/1/${INLINE_REPO}/issues/2` }];
		const read = reading(issueRow({ blockedBy: { nodes, totalCount: 1 } }));
		expect(read.tickets[0]?.blockers).toEqual([{ tracker: "github", repo: INLINE_REPO, host: null, key: "2" }]);
	});

	test("reads a blocker address carrying a trailing slash, a query, a fragment, or a pull request", () => {
		// Refusing any of these aborts a whole read over one edge, and each still names the repository and number
		// the ref is keyed by — a pull request among them, since GitHub numbers issues and pulls in one space.
		for (const address of [
			`${INLINE_REPO}/issues/2/`,
			`${INLINE_REPO}/issues/2?before=x`,
			`${INLINE_REPO}/issues/2#issuecomment-1`,
			`${INLINE_REPO}/pull/2`,
		]) {
			const nodes = [{ number: 2, state: "OPEN", url: address }];
			const read = reading(issueRow({ blockedBy: { nodes, totalCount: 1 } }));
			expect(read.tickets[0]?.blockers).toEqual([{ tracker: "github", repo: INLINE_REPO, host: null, key: "2" }]);
		}
	});

});

describe("the row fetched only to detect truncation", () => {
	test("still answers for its own openness, so a stale edge cannot decide in its place", () => {
		// #1's edge claims its blocker #2 is closed; #2's own row says it is open. Dropping #2 from the graph with
		// the probe row would leave that stale edge deciding, and #1 would read unblocked at a limit of 1.
		const rows = [
			issueRow({ blockedBy: { nodes: [blockerNode(2, "CLOSED")], totalCount: 1 } }),
			issueRow({ number: 2, title: "the blocker", url: `${INLINE_REPO}/issues/2` }),
		];
		const stdout = JSON.stringify(rows);
		for (const limit of [2, 1]) {
			const read = readGitHubTicketSet({ repo: INLINE_REPO, limit, runner: () => ({ code: 0, stdout, stderr: "" }) });
			expect(read.tickets).toHaveLength(limit);
			expect(blockednessOfFirst(read)).toBe("blocked");
		}
	});
});

describe("rows that answer for more than one repository", () => {
	test("are refused, since refs on one graph have to agree on how much they know", () => {
		const read = () =>
			reading(issueRow(), issueRow({ number: 2, title: "elsewhere", url: "other/repo/issues/2" }));
		expect(read).toThrow(/more than one repository/);
	});
});

describe("a repository spelled differently from how the tracker spells it", () => {
	test("still matches a blocker the read returned, so its own row is what answers for it", () => {
		// GitHub repository paths are case-insensitive, and a rename redirects, so the caller's spelling and the
		// tracker's can differ. Keying a ticket by the caller's made an in-read blocker look outside the read and
		// take its openness from a dependent's stale edge — here that edge claims issue 2 is closed while issue
		// 2's own row says it is open, and the row has to win.
		const rows = [
			issueRow({ blockedBy: { nodes: [blockerNode(2, "CLOSED")], totalCount: 1 } }),
			issueRow({ number: 2, title: "the blocker", url: `${INLINE_REPO}/issues/2` }),
		];
		const stdout = JSON.stringify(rows);
		const read = readGitHubTicketSet({
			repo: "Example/Repo",
			limit: 5,
			runner: () => ({ code: 0, stdout, stderr: "" }),
		});
		expect(read.tickets[0]?.ref.repo).toBe(INLINE_REPO);
		expect(blockednessOfFirst(read)).toBe("blocked");
		expect(read.degraded).toEqual([]);
	});
});

describe("a blocker list that arrived as a page", () => {
	// GitHub emits this — an issue with more blockers than the CLI returns at once — and the tree cannot hold one,
	// so there is no recording behind it and ADR-0027 says so rather than hand-writing one. What is asserted here
	// is our own policy on an incomplete list, which holds whoever produced it; the input stays inline and is
	// never stored under `fixtures/recordings`, which is what ADR-0019 governs.
	test("holds its ticket back, rather than judging it or losing the whole read", () => {
		const blockedBy = { nodes: [blockerNode(2, "OPEN")], totalCount: 3 };
		const read = reading(issueRow({ blockedBy }), issueRow({ number: 5, title: "readable", url: `${INLINE_REPO}/issues/5` }));
		expect(read.tickets.map((one) => one.ref.key)).toEqual(["5"]);
		expect(read.degraded).toEqual([
			{ kind: "partial-blocking", refs: [{ tracker: "github", repo: INLINE_REPO, host: null, key: "1" }] },
		]);
	});
});

describe("two edges disagreeing about one blocker outside the read", () => {
	// What is asserted is that a disagreement is refused rather than resolved, which holds whoever produced it —
	// so these rows claim nothing about what GitHub returns, and ADR-0019's provenance rule does not reach them.
	function disagreeing(first: string, second: string): TicketSetRead {
		const row = (n: number, blockerState: string) =>
			issueRow({
				number: n,
				title: `ticket ${n}`,
				url: `${INLINE_REPO}/issues/${n}`,
				blockedBy: { nodes: [blockerNode(99, blockerState)], totalCount: 1 },
			});
		return reading(row(1, first), row(2, second));
	}

	test("takes neither reading, whichever order they arrive in", () => {
		expect(blockednessOfFirst(disagreeing("OPEN", "CLOSED"))).toBe("unknown");
		expect(blockednessOfFirst(disagreeing("CLOSED", "OPEN"))).toBe("unknown");
	});

	test("says so, rather than degrading a ticket silently", () => {
		const read = disagreeing("OPEN", "CLOSED");
		expect(read.degraded).toHaveLength(1);
		expect(read.degraded[0]).toEqual({
			kind: "contradicted-blocker",
			refs: [{ tracker: "github", repo: INLINE_REPO, host: null, key: "99" }],
		});
	});

	test("leaves a blocker the read itself returned answering for its own state", () => {
		// The same disagreement about a blocker that is *in* the read: its own row says open, one dependent's
		// edge says closed, and the row wins — so this stays confidently blocked rather than degrading.
		const read = reading(
			issueRow({ blockedBy: { nodes: [blockerNode(2, "CLOSED")], totalCount: 1 } }),
			issueRow({ number: 2, title: "the blocker", url: `${INLINE_REPO}/issues/2` }),
		);
		expect(blockednessOfFirst(read)).toBe("blocked");
		expect(read.degraded).toEqual([]);
	});
});

describe("the repository a read is about", () => {
	function watching(remote: string, response: Runner): { readonly asked: string[][]; readonly runner: Runner } {
		const asked: string[][] = [];
		const answering = answeringOrigin(remote, response);
		const runner: Runner = (argv) => {
			asked.push([...argv]);
			return answering(argv);
		};
		return { asked, runner };
	}

	test("is the working directory's remote when the caller names none", () => {
		const { asked, runner } = watching(REMOTE, respondingRunner(githubRecording("read-defect")));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(GitHubAdapterError);
		expect(asked[1]).toEqual([...githubIssueListCommand({ repo: "example/repo", rows: 2 })]);
	});

	test("refuses a remote on a host this adapter does not read, before asking any tracker anything", () => {
		// A read carries no hostname, so a remote elsewhere would be asked of github.com — answering about a
		// different repository that happens to share the path, which is somebody else's work.
		const { asked, runner } = watching(ELSEWHERE_REMOTE, respondingRunner(githubRecording("ticket-set")));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(/reads github/);
		expect(asked).toHaveLength(1);
	});

	test("refuses a remote that names no GitHub owner and repository, before asking the tracker anything", () => {
		const { asked, runner } = watching(NESTED_REMOTE, respondingRunner(githubRecording("ticket-set")));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(/owner and repository/);
		expect(asked).toHaveLength(1);
	});

	test("refuses when there is no remote to resolve", () => {
		const runner: Runner = () => ({ code: 1, stdout: "", stderr: "fatal: No such remote 'origin'\n" });
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(GitHubAdapterError);
	});
});

describe("the limit a read is given", () => {
	const refused = (limit: number) => () =>
		readGitHubTicketSet({ repo: REPO, limit, runner: replayRunner([githubRecording("ticket-set")]) });

	test("is refused at zero and below, where a read would ask for a page it cannot report on", () => {
		expect(refused(0)).toThrow(/above zero/);
		expect(refused(-1)).toThrow(/above zero/);
	});

	test("is refused when it is not a whole number of tickets", () => {
		expect(refused(1.5)).toThrow(/whole number/);
	});

	test("is refused where asking for one row more would leave the range, rather than failing as a bad command", () => {
		expect(refused(Number.MAX_SAFE_INTEGER)).toThrow(GitHubAdapterError);
	});

	test("asks for exactly one row more than it was given", () => {
		const asked: string[][] = [];
		const runner: Runner = (argv) => {
			asked.push([...argv]);
			return { code: 0, stdout: "[]", stderr: "" };
		};
		readGitHubTicketSet({ repo: REPO, limit: 7, runner });
		expect(asked[0]).toEqual([...githubIssueListCommand({ repo: REPO, rows: 8 })]);
	});
});

describe("readGitHubTicket, over a single named ticket", () => {
	function viewing(name: string, overrides: Partial<TicketRef> = {}): TicketRead {
		const recording = githubRecording(name);
		return readGitHubTicket({
			runner: replayRunner([recording]),
			ref: { tracker: "github", repo: REPO, host: null, key: recordedIssue(recording), ...overrides },
		});
	}

	function refusing(ref: TicketRef): () => TicketRead {
		return () => readGitHubTicket({ runner: unreachable, ref });
	}

	/** Fails the test if anything runs, for the refusals that have to land before a call goes out. */
	const unreachable: Runner = (argv) => {
		throw new Error(`the read issued ${argv.join(" ")} when it should have refused first`);
	};

	test("normalizes the named ticket and confirms its blockers closed from the edges' own state", () => {
		const read = viewing("ticket-view");
		expect(read.ticket.title).toBe(shapeTitle(GITHUB_TEST_TREE, "every-blocker-closed"));
		expect(read.ticket.state).toBe("open");
		expect(read.ticket.claim).toBeNull();
		expect(read.ticket.blockers).not.toBe("unknown");
		expect(deriveEffectiveBlockedness(ticketId(read.ticket.ref), read.graph)).toBe("unblocked");
		expect(read.degraded).toEqual([]);
	});

	// The whole reason this is its own call rather than a lookup in the set read, which asks for open tickets
	// only and so can answer about this ticket at all — ADR-0037.
	test("answers about a closed ticket, which the set read cannot return", () => {
		const read = viewing("ticket-view-closed");
		expect(read.ticket.title).toBe(shapeTitle(GITHUB_TEST_TREE, "closed-blocker"));
		expect(read.ticket.state).toBe("closed");
	});

	test("carries the claim somebody else holds, rather than reporting the ticket unclaimed", () => {
		const read = viewing("ticket-view-claimed");
		expect(read.ticket.claim?.by).toBeTruthy();
	});

	test("reads a confirmed open blocker as blocked, from the edge the tracker returned", () => {
		const read = viewing("ticket-view-blocked");
		expect(deriveEffectiveBlockedness(ticketId(read.ticket.ref), read.graph)).toBe("blocked");
	});

	test("emits the same reference form the set read does, so one ticket cannot occupy two graph nodes", () => {
		const read = viewing("ticket-view", { host: GITHUB_HOST });
		expect(read.ticket.ref.host).toBeNull();
		expect(read.ticket.ref.repo).toBe(REPO);
	});

	test("fails loud on a ticket the tracker does not have, rather than reporting it unreadable", () => {
		const defect = githubRecording("ticket-view-defect");
		const key = defect.argv[defect.argv.indexOf("--") + 1]!;
		const refused = () =>
			readGitHubTicket({ runner: replayRunner([defect]), ref: { tracker: "github", repo: REPO, host: null, key } });
		expect(refused).toThrow(GitHubAdapterError);
		expect(refused).toThrow(/retry will not fix/);
	});

	/**
	 * An outage aborts here where the set read degrades past one. The set read has an answer to give with less
	 * in it; this read's whole answer is the one ticket, so there is nothing to continue with — the same
	 * reasoning `claimGitHubTicket` states for a failed write.
	 */
	test("aborts on an outage, saying which failure it was rather than degrading to an answer it does not have", () => {
		const refused = () =>
			readGitHubTicket({
				runner: respondingRunner(githubRecording("read-outage")),
				ref: { tracker: "github", repo: REPO, host: null, key: "1" },
			});
		expect(refused).toThrow(GitHubAdapterError);
		expect(refused).toThrow(/could not be reached/);
	});

	test("refuses a reference on a tracker this has no adapter for, before asking anything", () => {
		expect(refusing({ tracker: "gitlab", repo: "group/project", host: null, key: "1" })).toThrow(/GitHub/);
		expect(refusing({ tracker: "jira", repo: null, host: null, key: "ABC-7" })).toThrow(/GitHub/);
	});

	test("refuses a reference naming no owner and repository, and one on another host", () => {
		expect(refusing({ tracker: "github", repo: null, host: null, key: "1" })).toThrow(/owner and repository/);
		expect(refusing({ tracker: "github", repo: REPO, host: "example.test", key: "1" })).toThrow("example.test");
	});

	test("refuses a row answering about a different issue than the one named", () => {
		const runner: Runner = () => ({ code: 0, stdout: JSON.stringify(issueRow({ number: 2, url: `${INLINE_REPO}/issues/2` })), stderr: "" });
		const refused = () => readGitHubTicket({ runner, ref: { tracker: "github", repo: INLINE_REPO, host: null, key: "1" } });
		expect(refused).toThrow(/answered about/);
	});

	test("refuses a response that is not one issue object", () => {
		const named: TicketRef = { tracker: "github", repo: INLINE_REPO, host: null, key: "1" };
		const answering = (stdout: string) => () => readGitHubTicket({ runner: () => ({ code: 0, stdout, stderr: "" }), ref: named });
		expect(answering("not json")).toThrow(/returned no JSON/);
		expect(answering(JSON.stringify([issueRow()]))).toThrow(/one issue/);
	});

	/**
	 * A page of blockers reads as unknown here rather than holding the ticket out of the answer, because the
	 * ticket *is* the answer — ADR-0037, which also names what that costs.
	 */
	test("reads a page of blockers as unknown, and says a page is what arrived", () => {
		const runner: Runner = () => ({
			code: 0,
			stdout: JSON.stringify(issueRow({ blockedBy: { nodes: [blockerNode(2, "CLOSED")], totalCount: 2 } })),
			stderr: "",
		});
		const read = readGitHubTicket({ runner, ref: { tracker: "github", repo: INLINE_REPO, host: null, key: "1" } });
		expect(read.ticket.blockers).toBe("unknown");
		expect(deriveEffectiveBlockedness(ticketId(read.ticket.ref), read.graph)).toBe("unknown");
		expect(read.degraded).toEqual([{ kind: "partial-blocking", refs: [read.ticket.ref] }]);
	});

	test("reads a blocking field that did not answer as unknown, and says so", () => {
		const row = issueRow();
		delete row.blockedBy;
		const read = readGitHubTicket({
			runner: () => ({ code: 0, stdout: JSON.stringify(row), stderr: "" }),
			ref: { tracker: "github", repo: INLINE_REPO, host: null, key: "1" },
		});
		expect(deriveEffectiveBlockedness(ticketId(read.ticket.ref), read.graph)).toBe("unknown");
		expect(read.degraded).toEqual([{ kind: "unreadable-blocking", tickets: 1, of: 1 }]);
	});

	test("seeds a ticket that blocks itself without collapsing it onto two nodes", () => {
		const row = issueRow({ blockedBy: { nodes: [blockerNode(1, "OPEN")], totalCount: 1 } });
		const read = readGitHubTicket({
			runner: () => ({ code: 0, stdout: JSON.stringify(row), stderr: "" }),
			ref: { tracker: "github", repo: INLINE_REPO, host: null, key: "1" },
		});
		expect(deriveEffectiveBlockedness(ticketId(read.ticket.ref), read.graph)).toBe("blocked");
	});
});
