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
				title: argv[argv.indexOf("--title") + 1] as string,
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
			const add = argv.indexOf("--add-assignee");
			if (add >= 0) issue.assignees.push({ login: argv[add + 1] === "@me" ? "tester" : (argv[add + 1] as string) });
			const remove = argv.indexOf("--remove-assignee");
			if (remove >= 0) issue.assignees = issue.assignees.filter((a) => a.login !== argv[remove + 1]);
			return ok();
		}

		// Before the read branch below, which matches the same path: a POST carries it too, so reversing
		// these answers every edge write with the current edge list and silently writes nothing.
		if (noun === "api" && argv.includes("--method")) {
			const blocked = atPath(argv[4] as string);
			const blockerId = Number((argv[argv.indexOf("-F") + 1] as string).split("=")[1]);
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

		if (noun === "api") return ok(`${atPath(argv[2] as string).number + 1000}\n`);

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
		for (const issue of GITHUB_TEST_TREE.issues) {
			const built = tracker.issues.find((candidate) => candidate.title === issue.title);
			expect(built?.labels).toEqual([...issue.labels]);
			expect(built?.state).toBe(issue.closed ? "CLOSED" : "OPEN");
			expect((built?.assignees ?? []).length > 0).toBe(issue.claimed);
			expect(built?.blockedBy).toHaveLength(issue.blockedBy.length);
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

	// A listing missing `title` used to read as "no spec issue exists", which creates a second copy of the
	// whole tree on every run. The trigger is the `--json` field list and `ExistingIssue` drifting apart,
	// so the parse refuses the shape rather than trusting a cast.
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
	])("refuses a listing missing %s", (_label, stdout, because) => {
		// Every other call answers plausibly, so the parse is the only thing that can fail. Answering them
		// with a bare success instead made all six pass on `createIssue`'s "printed no issue number" throw,
		// which is the same error class and proves nothing about the listing.
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

	// The validator checks the spec; this checks the tracker, and the two are independent. A tree already
	// built from a duplicate-title spec — or one issue renamed onto another's title — keeps an issue that
	// the title map silently drops, so no later run can see or heal it while every recording captures it.
	test("refuses a listing in which two issues share a title", () => {
		const tracker = fakeTracker();
		provisionTestTree(GITHUB_TEST_TREE, tracker.runner);
		const [first, second] = tracker.issues;
		if (first !== undefined && second !== undefined) second.title = first.title;

		expect(() => provisionTestTree(GITHUB_TEST_TREE, tracker.runner)).toThrow(/share the title/);
	});

	test("refuses a create whose output carries no issue number", () => {
		const spec: TestTreeSpec = { ...GITHUB_TEST_TREE, issues: GITHUB_TEST_TREE.issues.slice(0, 1) };
		const mute: Runner = (argv) => (argv[2] === "list" ? ok("[]") : ok("created\n"));
		expect(() => provisionTestTree(spec, mute)).toThrow(/no issue number/);
	});
});
