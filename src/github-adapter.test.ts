import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { githubIssueListCommand } from "./command-builders";
import { deriveEffectiveBlockedness } from "./effective-blockedness";
import { GitHubAdapterError, type TicketSetRead, readGitHubTicketSet } from "./github-adapter";
import { readPriority } from "./priority";
import { loadRecording, recordingsDir, replayRunner, respondingRunner } from "./recording";
import type { Runner } from "./runner";
import { GITHUB_TEST_TREE } from "./test-tree";
import { type Ticket, ticketId } from "./ticket";

const REPO = GITHUB_TEST_TREE.repo;

const WHOLE_TREE = GITHUB_TEST_TREE.issues.length;

/** The limit `ticket-set-truncated.json` was captured under, which `capture-github-recordings.ts` fixes. */
const TRUNCATING = 3;

const REMOTE = "https://example.com/example/repo.git";
const NESTED_REMOTE = "https://example.com/group/subgroup/project.git";

function recording(name: string) {
	return loadRecording(join(recordingsDir("github"), `${name}.json`));
}

/**
 * The ticket carrying one test-tree shape, found by the spec's title rather than by number, because a
 * rebuilt tree renumbers — ADR-0023.
 */
function shape(read: TicketSetRead, key: string): Ticket {
	const issue = GITHUB_TEST_TREE.issues.find((one) => one.key === key);
	if (issue === undefined) throw new Error(`${key} is not a shape the test tree carries`);
	const ticket = read.tickets.find((one) => one.title === issue.title);
	if (ticket === undefined) throw new Error(`the read carries no ticket titled ${issue.title}`);
	return ticket;
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
		expect(read.outages).toEqual([]);
		expect([...read.tickets].map((one) => one.title).sort()).toEqual(
			[...GITHUB_TEST_TREE.issues].map((one) => one.title).sort(),
		);
	});

	test("emits one reference form for the whole set, carrying the repository and no host", () => {
		for (const ticket of wholeTree().tickets) {
			expect(ticket.ref.tracker).toBe("github");
			expect(ticket.ref.repo).toBe(REPO);
			expect(ticket.ref.host).toBeNull();
			expect(ticket.ref.key).toMatch(/^\d+$/);
		}
	});

	test("reads the tracker's own open/closed state per ticket", () => {
		const read = wholeTree();
		expect(shape(read, "closed-blocker").state).toBe("closed");
		expect(shape(read, "open-blocker").state).toBe("open");
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
		expect(shape(read, "every-blocker-closed").blockers).toHaveLength(1);
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

	test("reports itself truncated when the over-fetched row arrives", () => {
		const read = truncated();
		expect(read.truncated).toBe(true);
		expect(read.tickets).toHaveLength(TRUNCATING + 1);
	});

	test("still blocks on a blocker the read stopped short of, from the state its own edge carried", () => {
		const read = truncated();
		const blockers = shape(read, "cycle-second").blockers;
		if (blockers === "unknown") throw new Error("the truncated read was expected to carry this ticket's blocker");
		expect(blockers).toHaveLength(1);
		expect(read.tickets.some((one) => one.ref.key === blockers[0]?.key)).toBe(false);
		expect(blockedness(read, "cycle-second")).toBe("blocked");
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
		expect(read.outages).toHaveLength(1);
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
		expect(read.outages).toHaveLength(1);
		expect(read.outages[0]).toMatch(/connect/i);
	});

	test("fails loud on a request that is itself wrong, rather than degrading past a defect", () => {
		const defect = recording("read-defect");
		const repo = defect.argv[defect.argv.indexOf("--repo") + 1]!;
		expect(() =>
			readGitHubTicketSet({ repo, limit: WHOLE_TREE, runner: replayRunner([defect]) }),
		).toThrow(GitHubAdapterError);
	});
});

describe("a response the read cannot parse", () => {
	// Built here rather than captured: these assert refusals of shapes no tracker emits, which is not the claim
	// ADR-0019 governs.
	function answering(stdout: string): TicketSetRead {
		return readGitHubTicketSet({ repo: REPO, limit: 1, runner: () => ({ code: 0, stdout, stderr: "" }) });
	}

	const row = (fields: Record<string, unknown>) =>
		JSON.stringify([
			{
				number: 1,
				title: "A ticket",
				state: "OPEN",
				assignees: [],
				labels: [],
				url: "example/repo/issues/1",
				blockedBy: { nodes: [], totalCount: 0 },
				...fields,
			},
		]);

	test("refuses a success carrying no JSON", () => {
		expect(() => answering("not json")).toThrow(/returned no JSON/);
	});

	test("refuses a success carrying something other than a list of issues", () => {
		expect(() => answering(`{"issues": []}`)).toThrow(/list of issues/);
	});

	test("refuses a row whose state is missing or is neither open nor closed", () => {
		expect(() => answering(row({ state: undefined }))).toThrow(/state is not a string/);
		expect(() => answering(row({ state: "MERGED" }))).toThrow(/neither open nor closed/);
	});

	test("refuses a row whose number, title or address it cannot read", () => {
		expect(() => answering(row({ number: "1" }))).toThrow(/number is not a whole number/);
		expect(() => answering(row({ title: null }))).toThrow(/title is not a string/);
		expect(() => answering(row({ url: "" }))).toThrow(/url is empty/);
	});

	test("refuses a row whose assignees or labels are not lists, rather than reading them as absent", () => {
		expect(() => answering(row({ assignees: undefined }))).toThrow(/claim cannot be read/);
		expect(() => answering(row({ labels: "P0" }))).toThrow(/labels is not a list/);
	});

	test("refuses a blocking field present in a shape it cannot read", () => {
		expect(() => answering(row({ blockedBy: { nodes: "one", totalCount: 1 } }))).toThrow(/not a list of blockers/);
		expect(() => answering(row({ blockedBy: { nodes: [], totalCount: null } }))).toThrow(/totalCount is not a whole number/);
	});

	test("refuses a blocker whose address names no owner and repository", () => {
		const nodes = [{ number: 2, state: "OPEN", url: "issues/2" }];
		expect(() => answering(row({ blockedBy: { nodes, totalCount: 1 } }))).toThrow(/names no owner and repository/);
	});
});

describe("two edges disagreeing about one blocker outside the read", () => {
	// Built here for a different reason than the block above: GitHub can emit this — a multi-page read sees a
	// blocker that closed between pages — but reaching it needs a race on a tree larger than ours. What is
	// asserted is that disagreement is refused rather than resolved, which holds whatever emits it.
	function reading(first: string, second: string): TicketSetRead {
		const row = (n: number, blockerState: string) => ({
			number: n,
			title: `ticket ${n}`,
			state: "OPEN",
			assignees: [],
			labels: [],
			url: `example/repo/issues/${n}`,
			blockedBy: { nodes: [{ number: 99, state: blockerState, url: "example/repo/issues/99" }], totalCount: 1 },
		});
		const stdout = JSON.stringify([row(1, first), row(2, second)]);
		return readGitHubTicketSet({ repo: "example/repo", limit: 5, runner: () => ({ code: 0, stdout, stderr: "" }) });
	}

	function blockednessOfFirst(read: TicketSetRead): string {
		return deriveEffectiveBlockedness(ticketId(read.tickets[0]!.ref), read.graph);
	}

	test("takes neither reading, whichever order they arrive in", () => {
		expect(blockednessOfFirst(reading("OPEN", "CLOSED"))).toBe("unknown");
		expect(blockednessOfFirst(reading("CLOSED", "OPEN"))).toBe("unknown");
	});

	test("says so, rather than degrading a ticket silently", () => {
		const read = reading("OPEN", "CLOSED");
		expect(read.outages).toHaveLength(1);
		expect(read.outages[0]).toMatch(/both open and closed/);
	});

	test("leaves a blocker the read itself returned answering for its own state", () => {
		// The same disagreement about a blocker that is *in* the read: its own row says open, one dependent's
		// edge says closed, and the row wins — so this stays confidently blocked rather than degrading.
		const rows = [
			{ number: 1, title: "blocked", state: "OPEN", assignees: [], labels: [], url: "example/repo/issues/1",
				blockedBy: { nodes: [{ number: 2, state: "CLOSED", url: "example/repo/issues/2" }], totalCount: 1 } },
			{ number: 2, title: "the blocker", state: "OPEN", assignees: [], labels: [], url: "example/repo/issues/2",
				blockedBy: { nodes: [], totalCount: 0 } },
		];
		const stdout = JSON.stringify(rows);
		const read = readGitHubTicketSet({ repo: "example/repo", limit: 5, runner: () => ({ code: 0, stdout, stderr: "" }) });
		expect(blockednessOfFirst(read)).toBe("blocked");
		expect(read.outages).toEqual([]);
	});
});

describe("the repository a read is about", () => {
	function watch(response: Runner): { readonly asked: string[][]; readonly runner: Runner } {
		const asked: string[][] = [];
		const remote = { code: 0, stdout: `${REMOTE}\n`, stderr: "" };
		const runner: Runner = (argv) => {
			asked.push([...argv]);
			return argv[0] === "git" ? remote : response(argv);
		};
		return { asked, runner };
	}

	test("is the working directory's remote when the caller names none", () => {
		const defect = recording("read-defect");
		const { asked, runner } = watch(respondingRunner(defect));
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(GitHubAdapterError);
		expect(asked[1]).toEqual([...githubIssueListCommand({ repo: "example/repo", rows: 2 })]);
	});

	test("refuses a remote that names no GitHub owner and repository, before asking the tracker anything", () => {
		const asked: string[][] = [];
		const runner: Runner = (argv) => {
			asked.push([...argv]);
			return { code: 0, stdout: `${NESTED_REMOTE}\n`, stderr: "" };
		};
		expect(() => readGitHubTicketSet({ limit: 1, runner })).toThrow(GitHubAdapterError);
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
