export class TestTreeError extends Error {
	/**
	 * What provisioning had already written when it failed, when it failed partway. Empty for a failure that
	 * changed nothing, and for every validation error. Carried on the error because the alternative is an
	 * operator who knows a call failed and nothing about the writes that landed — including whether the tree
	 * now holds an issue no later run can reach.
	 */
	readonly changes: readonly { readonly key: string; readonly action: string }[];

	constructor(message: string, changes: readonly { readonly key: string; readonly action: string }[] = []) {
		super(message);
		this.changes = changes;
	}
}

/** The colour is pinned because a recording captures it. */
export interface TestTreeLabel {
	readonly name: string;
	readonly color: string;
}

/**
 * One issue on a test tree, keyed by `key` rather than by issue number, because a rebuilt tree renumbers.
 * ADR-0023 has why.
 */
export interface TestTreeIssue {
	readonly key: string;
	readonly title: string;
	readonly body: string;
	readonly labels: readonly string[];
	/** Keys of the issues this one is blocked by, as native tracker dependency edges. */
	readonly blockedBy: readonly string[];
	/** `write-target` is the only issue a test may assign and unassign. */
	readonly claimed: boolean;
	readonly closed: boolean;
}

export interface TestTreeSpec {
	/** `owner/repo`. Carries no host, so the identifier guard has nothing to match — see ADR-0024. */
	readonly repo: string;
	readonly labels: readonly TestTreeLabel[];
	readonly issues: readonly TestTreeIssue[];
}

/** The GitHub test tree. Every shape here is one ticket 35 asked the tree to carry. */
export const GITHUB_TEST_TREE: TestTreeSpec = {
	repo: "nichenke/nextup-test-tree-github",
	labels: [
		{ name: "P0", color: "b60205" },
		{ name: "P1", color: "d93f0b" },
		{ name: "P2", color: "fbca04" },
		{ name: "priority: high", color: "c2e0c6" },
		{ name: "needs-triage", color: "ededed" },
		{ name: "wayfinder:task", color: "1d76db" },
	],
	issues: [
		{
			key: "chain-base",
			title: "Chain base: open, and the far end of a two-deep chain",
			body: "Blocks the chain middle and nothing blocks it. Open, so the whole chain above it stays blocked.",
			labels: ["P2"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "chain-middle",
			title: "Chain middle: blocked by the chain base, blocks the chain tip",
			body: "The intermediate hop. Propagation has to pass through here to learn that the chain tip is blocked.",
			labels: ["P1"],
			blockedBy: ["chain-base"],
			claimed: false,
			closed: false,
		},
		{
			key: "chain-tip",
			title: "Chain tip: blocked two deep, through the chain middle",
			body: "Its own blocker is open, and that blocker's blocker is open too. Nothing here is reachable in one hop.",
			labels: ["P0"],
			blockedBy: ["chain-middle"],
			claimed: false,
			closed: false,
		},
		{
			key: "closed-blocker",
			title: "Closed blocker: counted in the total, not in the open count",
			body: "Closed. Blocks two issues, so both report a total above their open blocker count.",
			labels: [],
			blockedBy: [],
			claimed: false,
			closed: true,
		},
		{
			key: "open-blocker",
			title: "Open blocker: counted in both the open count and the total",
			body: "Open, and carries no other shape, so it is the plain half of the mixed-blockers pair.",
			labels: [],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "mixed-blockers",
			title: "Mixed blockers: one closed and one open, so the two counts disagree",
			body: "Blocked by the closed blocker and the open blocker together. The open count reads one and the total reads two.",
			labels: ["P1"],
			blockedBy: ["closed-blocker", "open-blocker"],
			claimed: false,
			closed: false,
		},
		{
			key: "every-blocker-closed",
			title: "Every blocker closed: on the frontier, with a total above zero",
			body: "Its only blocker is closed, so it is unblocked while still reporting a blocker total. A reading that consults the total alone calls this blocked.",
			labels: ["P2"],
			blockedBy: ["closed-blocker"],
			claimed: false,
			closed: false,
		},
		{
			key: "claimed",
			title: "Claimed: assigned, so not a candidate",
			body: "Assigned, and stays assigned: the claim filter needs a ticket that is already taken.",
			labels: ["P0"],
			blockedBy: [],
			claimed: true,
			closed: false,
		},
		{
			key: "no-priority",
			title: "No priority label: the first rung is absent",
			body: "Carries no label at all, so the priority rung has nothing to read and is skipped for this ticket.",
			labels: [],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "unread-priority",
			title: "Unread priority shape: a named priority the ladder cannot order",
			body: "Priority-shaped, and not rankable. The reading reports it rather than guessing where it sits against a numbered rung.",
			labels: ["priority: high"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "several-priorities",
			title: "Several priority labels at once: the most urgent wins, the unreadable one is still reported",
			body: "Carries more than one priority label. Labels are a set, so a tracker permits this and a reading has to choose.",
			labels: ["P0", "P2", "priority: high"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "needs-triage",
			title: "Needs triage: excluded from candidates, still in the graph",
			body: "The label filter drops this from the candidate set without asking why it carries the label.",
			labels: ["needs-triage"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "excluded-blocker",
			title: "Wayfinder ticket: excluded by the default filter, and still a blocker",
			body: "Dropped from candidates by the default exclusion, and blocks a ticket that is not. An excluded ticket still blocks.",
			labels: ["wayfinder:task"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
		{
			key: "blocked-by-excluded",
			title: "Blocked by an excluded ticket",
			body: "Its only blocker is filtered out of the candidate set. A graph built from candidates alone reports this unblocked.",
			labels: ["P1"],
			blockedBy: ["excluded-blocker"],
			claimed: false,
			closed: false,
		},
		{
			key: "cycle-first",
			title: "Cycle, first hop: blocked by the third hop",
			body: "One third of a three-issue dependency cycle.",
			labels: ["P2"],
			blockedBy: ["cycle-third"],
			claimed: false,
			closed: false,
		},
		{
			key: "cycle-second",
			title: "Cycle, second hop: blocked by the first hop",
			body: "One third of a three-issue dependency cycle.",
			labels: ["P2"],
			blockedBy: ["cycle-first"],
			claimed: false,
			closed: false,
		},
		{
			key: "cycle-third",
			title: "Cycle, third hop: blocked by the second hop",
			body: "One third of a three-issue dependency cycle. This edge closes the loop.",
			labels: ["P2"],
			blockedBy: ["cycle-second"],
			claimed: false,
			closed: false,
		},
		{
			key: "write-target",
			title: "Write target: the only issue the claim path may assign and unassign",
			body: "Reserved for the write path. Every other issue's claim is a captured shape, so a test that claims one of those changes what the next recording says.",
			labels: ["P2"],
			blockedBy: [],
			claimed: false,
			closed: false,
		},
	],
};

/**
 * @throws TestTreeError when a key repeats, a `blockedBy` names no issue, or an issue carries a label
 * the spec never declares — the last of which `gh issue create` would otherwise reject mid-provision,
 * after some issues exist and others do not.
 */
export function validateTestTree(spec: TestTreeSpec): void {
	const keys = new Set<string>();
	const titles = new Set<string>();
	for (const issue of spec.issues) {
		if (keys.has(issue.key)) throw new TestTreeError(`${issue.key} is used by two issues`);
		keys.add(issue.key);
		// Titles matter as much as keys: reconciliation matches the tracker on title, so ADR-0023's title
		// paragraph applies to a repeat here as much as to one made by hand on the tracker.
		if (titles.has(issue.title)) throw new TestTreeError(`two issues share the title ${issue.title}`);
		titles.add(issue.title);
	}
	const declared = new Set(spec.labels.map((label) => label.name));
	if (declared.size !== spec.labels.length) {
		throw new TestTreeError("two labels share a name, and no tracker state satisfies both definitions");
	}
	const blockedBy = new Map(spec.issues.map((issue) => [issue.key, new Set(issue.blockedBy)]));
	for (const issue of spec.issues) {
		if (new Set(issue.blockedBy).size !== issue.blockedBy.length) {
			throw new TestTreeError(`${issue.key} names the same blocker twice`);
		}
		for (const blocker of issue.blockedBy) {
			// GitHub refuses any edge whose direct reverse already exists — ADR-0023 has the probe. Self-block is
			// that rule at length one and a mutual pair is it at length two; both resolve to real keys, so the
			// check below passes them and the run fails partway through instead.
			if (blocker === issue.key) throw new TestTreeError(`${issue.key} blocks itself`);
			if (!keys.has(blocker)) throw new TestTreeError(`${issue.key} is blocked by ${blocker}, which is not an issue`);
			if (blockedBy.get(blocker)?.has(issue.key)) {
				throw new TestTreeError(`${issue.key} and ${blocker} block each other`);
			}
		}
		for (const label of issue.labels) {
			if (!declared.has(label)) throw new TestTreeError(`${issue.key} carries ${label}, which the spec does not declare`);
		}
	}
}
