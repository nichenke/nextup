import { describe, expect, test } from "bun:test";
import type { CommandResult, Runner } from "./runner";
import { GITHUB_PLACEHOLDER_HOST } from "./recording-identifiers";
import { GITHUB_TEST_TREE, type TestTreeSpec, TestTreeError } from "./test-tree";
import { provisionTestTree } from "./test-tree-provision";

interface FakeIssue {
	number: number;
	title: string;
	labels: string[];
	assignees: { login: string }[];
	state: "OPEN" | "CLOSED";
	blockedBy: number[];
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/**
 * A tracker that answers the calls provisioning makes. It refuses an edge whose direct reverse already
 * exists, which is the rule the real GitHub enforces.
 *
 * A database id is minted as issue number + 1000, so the two cannot be confused: the dependency endpoint
 * takes an issue's database id and not its number, and a fake that returned the number would accept the
 * wrong argument as readily as the right one.
 */
function fakeTracker(seed: FakeIssue[] = []) {
	const issues = [...seed];
	const calls: string[][] = [];
	let next = Math.max(0, ...issues.map((issue) => issue.number)) + 1;

	const find = (number: number): FakeIssue => {
		const issue = issues.find((candidate) => candidate.number === number);
		if (issue === undefined) throw new Error(`no fake issue ${number}`);
		return issue;
	};

	const atPath = (path: string): FakeIssue => {
		const segments = path.split("/");
		return find(Number(segments[segments.indexOf("issues") + 1]));
	};

	const runner: Runner = (argv) => {
		calls.push(argv);
		const [, noun, verb] = argv;

		// Returns undefined for an absent flag rather than argv[0], which a bare `indexOf(name) + 1` does.
		const flagValue = (name: string): string | undefined => {
			const at = argv.indexOf(name);
			return at < 0 ? undefined : argv[at + 1];
		};

		if (noun === "label") return ok();

		if (noun === "issue" && verb === "list") {
			return ok(
				JSON.stringify(
					issues.map(({ number, title, state, assignees }) => ({ number, title, state, assignees })),
				),
			);
		}

		if (noun === "issue" && verb === "create") {
			const number = next++;
			const labels: string[] = [];
			for (let index = 0; index < argv.length; index += 1) {
				if (argv[index] === "--label") labels.push(argv[index + 1] as string);
			}
			issues.push({
				number,
				title: flagValue("--title") as string,
				labels,
				assignees: [],
				state: "OPEN",
				blockedBy: [],
			});
			return ok(`${GITHUB_PLACEHOLDER_HOST}/owner/repo/issues/${number}\n`);
		}

		if (noun === "issue" && (verb === "close" || verb === "reopen")) {
			find(Number(argv[3])).state = verb === "close" ? "CLOSED" : "OPEN";
			return ok();
		}

		if (noun === "issue" && verb === "edit") {
			const issue = find(Number(argv[3]));
			const add = flagValue("--add-assignee");
			if (add !== undefined) issue.assignees.push({ login: add === "@me" ? "tester" : add });
			const remove = flagValue("--remove-assignee");
			if (remove !== undefined) issue.assignees = issue.assignees.filter((a) => a.login !== remove);
			return ok();
		}

		// Each api branch keys on a distinct argv slot, so an unrecognised call reaches the throw at the end
		// rather than being answered by whichever branch happens to be broadest.
		if (noun === "api" && argv.includes("--method")) {
			const blocked = atPath(argv[4] as string);
			const blockerId = Number((flagValue("-F") as string).split("=")[1]);
			const blocker = find(blockerId - 1000);
			if (blocker.blockedBy.includes(blocked.number)) {
				return { code: 1, stdout: "", stderr: "Validation failed: this dependency would create a cycle" };
			}
			blocked.blockedBy.push(blocker.number);
			return ok();
		}

		if (noun === "api" && argv[2]?.endsWith("/dependencies/blocked_by")) {
			return ok(JSON.stringify(atPath(argv[2] as string).blockedBy));
		}

		if (noun === "api" && argv[4] === ".id") return ok(`${atPath(argv[2] as string).number + 1000}\n`);

		throw new Error(`fake tracker got an unexpected call: ${argv.join(" ")}`);
	};

	return { runner, issues, calls };
}

describe("provisionTestTree", () => {
	test("builds the whole tree from an empty tracker", () => {
		const tracker = fakeTracker();
		const report = provisionTestTree(GITHUB_TEST_TREE, tracker.runner);

		expect(tracker.issues).toHaveLength(GITHUB_TEST_TREE.issues.length);
		expect(report.changes.filter((change) => change.action === "created")).toHaveLength(
			GITHUB_TEST_TREE.issues.length,
		);
		// The blocker key inside a `blocked by ...` action is a string the type cannot constrain, so nothing
		// but this catches an edit that interpolates the wrong variable into it.
		const edges = report.changes.filter((change) => change.action.startsWith("blocked by"));
		expect(edges.map((change) => `${change.key} ${change.action}`).sort()).toEqual(
			GITHUB_TEST_TREE.issues
				.flatMap((issue) => issue.blockedBy.map((blocker) => `${issue.key} blocked by ${blocker}`))
				.sort(),
		);
		for (const issue of GITHUB_TEST_TREE.issues) {
			const built = tracker.issues.find((candidate) => candidate.title === issue.title);
			expect(built?.labels).toEqual([...issue.labels]);
			expect(built?.state).toBe(issue.closed ? "CLOSED" : "OPEN");
			expect((built?.assignees ?? []).length > 0).toBe(issue.claimed);
			// Identity, not just count: an edge wired to the wrong blocker satisfies a length check, and it is
			// the only failure a mis-resolved key or a confused id would actually produce. The fake mints ids
			// as number + 1000 precisely so the two cannot be swapped unnoticed.
			const expected = issue.blockedBy.map((key) => {
				const blocker = GITHUB_TEST_TREE.issues.find((candidate) => candidate.key === key);
				const number = tracker.issues.find((candidate) => candidate.title === blocker?.title)?.number;
				// Loud rather than compared as undefined, which would make two failed lookups match each other.
				if (number === undefined) throw new Error(`no built issue for blocker ${key}`);
				return number;
			});
			expect([...(built?.blockedBy ?? [])].sort()).toEqual([...expected].sort());
		}
	});

	test("declares every label before any issue names one", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const firstIssue = tracker.calls.findIndex((argv) => argv[1] === "issue");
		const lastLabel = tracker.calls.reduce((last, argv, index) => (argv[1] === "label" ? index : last), -1);
		expect(lastLabel).toBeLessThan(firstIssue);
	});

	test("changes nothing on a second run", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const report = provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		expect(report.changes).toEqual([]);
		expect(tracker.issues).toHaveLength(GITHUB_TEST_TREE.issues.length);
	});

	test("releases an issue the write path left claimed", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const target = tracker.issues.find((issue) => issue.title.startsWith("Write target"));
		target?.assignees.push({ login: "tester" });

		const report = provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		expect(report.changes).toEqual([{ key: "write-target", action: "released" }]);
		expect(target?.assignees).toEqual([]);
	});

	test("reopens an issue the tree wants open", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const reopened = tracker.issues.find((issue) => issue.title.startsWith("Chain base"));
		if (reopened !== undefined) reopened.state = "CLOSED";

		const report = provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		expect(report.changes).toEqual([{ key: "chain-base", action: "reopened" }]);
		expect(reopened?.state).toBe("OPEN");
	});

	test("stops loudly when a call fails, rather than reporting a tree that does not exist", () => {
		const failing: Runner = () => ({ code: 1, stdout: "", stderr: "gh: HTTP 403" });
		expect(() => provisionTestTree(GITHUB_TEST_TREE, failing)).toThrow(TestTreeError);
	});

	test("refuses a listing that fills the page, which cannot be told from a truncated one", () => {
		const flooded: Runner = (argv) =>
			argv[2] === "list"
				? ok(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ number: i + 1, title: `t${i}`, state: "OPEN", assignees: [] }))))
				: ok();
		expect(() => provisionTestTree(GITHUB_TEST_TREE, flooded)).toThrow(/truncated/);
	});

	// A listing missing `title` reads as "no spec issue exists" unless the parse refuses it, and ADR-0023 has
	// what that costs. The trigger is the `--json` field list and `ExistingIssue` drifting apart.
	// Each case asserts *why* it was refused, not merely that something threw. An absent `assignees` has to
	// refuse rather than read as unclaimed: a lenient `?? []` would satisfy a bare `toThrow` by turning the
	// failure into a silent "nobody is working on this", which is how a claim filter advertises work that
	// somebody already holds.
	test.each([
		["title", `[{"number":1,"state":"OPEN","assignees":[]}]`, /has no title/],
		["state", `[{"number":1,"title":"t","assignees":[]}]`, /unrecognised state/],
		["assignees", `[{"number":1,"title":"t","state":"OPEN"}]`, /has no usable assignees/],
		["number", `[{"title":"t","state":"OPEN","assignees":[]}]`, /has no usable number/],
		["a state nothing recognises", `[{"number":1,"title":"t","state":"MERGED","assignees":[]}]`, /unrecognised state/],
		["an object instead of a list", `{"number":1}`, /not a list/],
		["empty, which gh can print while exiting 0", ``, /not JSON/],
		["not JSON at all", `warning: something\n`, /not JSON/],
		["a null entry, which destructuring would raise a TypeError on", `[null]`, /is not an object/],
		["an array entry, which has no fields at all", `[[]]`, /is not an object/],
	])("refuses a listing missing %s", (_label, stdout, because) => {
		// Every other call has to answer plausibly, or these pass on `createIssue`'s "printed no issue
		// number" throw instead of on the parse — the same error class, proving nothing about the listing.
		const broken: Runner = (argv) => {
			if (argv[2] === "list") return ok(stdout);
			if (argv[2] === "create") return ok(`${GITHUB_PLACEHOLDER_HOST}/owner/repo/issues/1\n`);
			if (argv[1] === "api" && argv[2]?.endsWith("/dependencies/blocked_by")) return ok("[]");
			if (argv[1] === "api") return ok("1001\n");
			return ok();
		};
		expect(() => provisionTestTree(GITHUB_TEST_TREE, broken)).toThrow(TestTreeError);
		expect(() => provisionTestTree(GITHUB_TEST_TREE, broken)).toThrow(because);
	});

	// `validateTestTree` checks the spec; this checks the tracker, and the two can be violated independently
	// — ADR-0023 has what a stranded issue costs.
	test("refuses a listing in which two issues share a title", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const [first, second] = tracker.issues;
		if (first !== undefined && second !== undefined) second.title = first.title;

		expect(() => provisionTestTree(GITHUB_TEST_TREE, tracker.runner)).toThrow(/share the title/);
	});

	test("names the failing subcommand, not just the binary", () => {
		const denied: Runner = () => ({ code: 1, stdout: "", stderr: "gh: HTTP 403" });
		expect(() => provisionTestTree(GITHUB_TEST_TREE, denied)).toThrow(/gh label create/);
	});

	test("reads edges only for the issues that declare one", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		tracker.calls.length = 0;
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);

		const reads = tracker.calls.filter((argv) => argv[2]?.endsWith("/dependencies/blocked_by"));
		const withBlockers = GITHUB_TEST_TREE.issues.filter((issue) => issue.blockedBy.length > 0);
		expect(reads).toHaveLength(withBlockers.length);
		expect(reads.length).toBeLessThan(GITHUB_TEST_TREE.issues.length);
	});

	test("treats any assignee as satisfying a claim, and releases every one of them", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const claimed = tracker.issues.find((issue) => issue.title.startsWith("Claimed:"));
		if (claimed !== undefined) claimed.assignees = [{ login: "somebody-else" }];

		expect(provisionTestTree(GITHUB_TEST_TREE, tracker.runner).changes).toEqual([]);
		expect(claimed?.assignees).toEqual([{ login: "somebody-else" }]);
	});

	// The same treatment `parseIssues` gets; `blockedBy`'s own comment has why a shape it cannot read is worse
	// than a failure.
	test.each([
		["not a list", `{"a":1}`, /not a list of issue numbers/],
		["a list of nulls", `[null]`, /not a list of issue numbers/],
		["a list of strings", `["7"]`, /not a list of issue numbers/],
		["a list holding zero", `[0]`, /not a list of issue numbers/],
	])("refuses a blocker listing that is %s", (_label, stdout, because) => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const corrupt: Runner = (argv) =>
			argv[1] === "api" && argv[2]?.endsWith("/dependencies/blocked_by") ? ok(stdout) : tracker.runner(argv);

		expect(() => provisionTestTree(GITHUB_TEST_TREE, corrupt)).toThrow(TestTreeError);
		expect(() => provisionTestTree(GITHUB_TEST_TREE, corrupt)).toThrow(because);
	});

	test("accepts an empty blocker listing, which is what an issue with no edges yet returns", () => {
		const tracker = fakeTracker();
		expect(() => provisionTestTree(GITHUB_TEST_TREE, tracker.runner)).not.toThrow();
	});

	// The id fetch's own comment has why an absent field is worse than a failed call.
	test("refuses a blocker id that came back empty", () => {
		// A fresh tracker, so no edges exist yet and the id fetch is actually reached.
		const tracker = fakeTracker();
		const blanked: Runner = (argv) =>
			argv[1] === "api" && argv[3] === "--jq" && argv[4] === ".id" ? ok("\n") : tracker.runner(argv);

		expect(() => provisionTestTree(GITHUB_TEST_TREE, blanked)).toThrow(/is not an issue id/);
	});

	// The duplicate-title refusal cannot see a rename: the renamed issue and the freshly created one carry
	// different titles, so nothing collides. What a rename leaves is an issue the spec does not describe, and
	// that is what this catches — along with a hand-created issue and a squat under any unclaimed title.
	test("refuses a listed issue the spec does not describe", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const renamed = tracker.issues.find((issue) => issue.title.startsWith("Chain tip"));
		if (renamed !== undefined) renamed.title = "Chain tip: blocked two deep (wip)";

		expect(() => provisionTestTree(GITHUB_TEST_TREE, tracker.runner)).toThrow(/does not describe/);
	});

	test("carries the writes that landed when it fails partway", () => {
		const tracker = fakeTracker();
		let creates = 0;
		// Keyed on `issue create`, not on `create` alone: `gh label create` shares that word, and counting it
		// made the failure fire before a single issue existed.
		const failing: Runner = (argv) => {
			const isIssueCreate = argv[1] === "issue" && argv[2] === "create";
			creates += isIssueCreate ? 1 : 0;
			return isIssueCreate && creates > 3 ? { code: 1, stdout: "", stderr: "gh: HTTP 403" } : tracker.runner(argv);
		};

		try {
			provisionTestTree(GITHUB_TEST_TREE, failing);
			throw new Error("expected provisioning to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TestTreeError);
			expect((error as TestTreeError).changes).toHaveLength(3);
		}
	});

	test("refuses a create whose output carries no issue number", () => {
		const spec: TestTreeSpec = { ...GITHUB_TEST_TREE, issues: GITHUB_TEST_TREE.issues.slice(0, 1) };
		const mute: Runner = (argv) => (argv[2] === "list" ? ok("[]") : ok("created\n"));
		expect(() => provisionTestTree(spec, mute)).toThrow(/no issue number/);
	});
});
