import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { githubIssueListCommand } from "./command-builders";
import { deriveEffectiveBlockedness } from "./effective-blockedness";
import { GitHubAdapterError, type TicketSetRead, readGitHubTicketSet } from "./github-adapter";
import { readPriority } from "./priority";
import { loadRecording, recordingsDir } from "./recording";
import type { Runner } from "./runner";
import { replayRunner, respondingRunner } from "./test-support";
import { GITHUB_TEST_TREE } from "./test-tree";
import { type Ticket, ticketId } from "./ticket";
import { GITHUB_HOST } from "./ticket-ref";

const REPO = GITHUB_TEST_TREE.repo;

/**
 * The tree's open issues, which is every row a read returns: the read asks for open tickets only, so a
 * closed shape is reachable here as a blocker on an edge and never as a ticket — ADR-0028.
 */
const OPEN_ISSUES = GITHUB_TEST_TREE.issues.filter((one) => !one.closed);

const WHOLE_TREE = OPEN_ISSUES.length;

/** The limit `ticket-set-truncated.json` was captured under, which `capture-github-recordings.ts` fixes. */
const TRUNCATING = 3;

// Built from the adapter's own accepted host, in git's scp form, so no spelling of it appears here for the
// identifier guard to read — and so these cannot drift from the host the adapter actually accepts.
const REMOTE = `git@${GITHUB_HOST}:example/repo.git`;
const NESTED_REMOTE = `git@${GITHUB_HOST}:group/subgroup/project.git`;
const ELSEWHERE_REMOTE = "https://example.com/example/repo.git";

function recording(name: string) {
	return loadRecording(join(recordingsDir("github"), `${name}.json`));
}

/**
 * The ticket carrying one test-tree shape, found by the spec's title rather than by number, because a
 * rebuilt tree renumbers — ADR-0023.
 */
function shape(read: TicketSetRead, key: string): Ticket {
	const title = titleOf(key);
	const ticket = read.tickets.find((one) => one.title === title);
	if (ticket === undefined) throw new Error(`the read carries no ticket titled ${title}`);
	return ticket;
}

function titleOf(key: string): string {
	const issue = GITHUB_TEST_TREE.issues.find((one) => one.key === key);
	if (issue === undefined) throw new Error(`${key} is not a shape the test tree carries`);
	return issue.title;
}

function blockedness(read: TicketSetRead, key: string): string {
	return deriveEffectiveBlockedness(ticketId(shape(read, key).ref), read.graph);
}

function wholeTree(): TicketSetRead {
	return readGitHubTicketSet({ repo: REPO, limit: WHOLE_TREE, runner: replayRunner([recording("ticket-set")]) });
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
		expect(read.tickets.map((one) => one.title)).not.toContain(titleOf("closed-blocker"));
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
		// The blocker is closed, so an open-only read does not return it as a row: this derives from the
		// closedness its own edge carried, which is what ADR-0028 rests on.
		expect(read.tickets.map((one) => one.title)).not.toContain(titleOf("closed-blocker"));
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
			runner: replayRunner([recording("ticket-set-truncated")]),
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
			runner: respondingRunner(recording("ticket-set-without-blockers")),
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
			runner: respondingRunner(recording("read-outage")),
		});
		expect(read.tickets).toEqual([]);
		expect(read.truncated).toBe(true);
		expect(read.degraded).toHaveLength(1);
		expect(read.degraded[0]?.kind).toBe("outage");
	});

	test("fails loud on a request that is itself wrong, rather than degrading past a defect", () => {
		const defect = recording("read-defect");
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
		const runner: Runner = (argv) => {
			asked.push([...argv]);
			return argv[0] === "git" ? { code: 0, stdout: `${remote}\n`, stderr: "" } : response(argv);
		};
		return { asked, runner };
	}

	test("is the working directory's remote when the caller names none", () => {
		const { asked, runner } = watching(REMOTE, respondingRunner(recording("read-defect")));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(GitHubAdapterError);
		expect(asked[1]).toEqual([...githubIssueListCommand({ repo: "example/repo", rows: 2 })]);
	});

	test("refuses a remote on a host this adapter does not read, before asking any tracker anything", () => {
		// A read carries no hostname, so a remote elsewhere would be asked of github.com — answering about a
		// different repository that happens to share the path, which is somebody else's work.
		const { asked, runner } = watching(ELSEWHERE_REMOTE, respondingRunner(recording("ticket-set")));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(/reads github/);
		expect(asked).toHaveLength(1);
	});

	test("refuses a remote that names no GitHub owner and repository, before asking the tracker anything", () => {
		const { asked, runner } = watching(NESTED_REMOTE, respondingRunner(recording("ticket-set")));
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
		readGitHubTicketSet({ repo: REPO, limit, runner: replayRunner([recording("ticket-set")]) });

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
