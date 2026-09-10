import { describe, expect, test } from "bun:test";
import { type CliDeps, DEFAULT_LIMIT, run } from "./cli";
import { DEFAULT_LABEL_FILTER } from "./label-filter";
import type { Runner } from "./runner";
import { DEADLOCK_PREFIX } from "./selection-output";
import { answeringOrigin, deadlockLines, githubRecording, replayRunner, respondingRunner, sentinelLines } from "./test-support";
import { GITHUB_TEST_TREE, openIssues, shapeTitle } from "./test-tree";
import { GITHUB_HOST } from "./ticket-ref";

/** Every test below runs through this, so a call that started shelling out fails loudly here first. */
const refuseToRun: Runner = (argv) => {
	throw new Error(`nothing may run an external process here: ${argv.join(" ")}`);
};

function terminal(answer = true): { confirm: CliDeps["confirm"]; questions: string[] } {
	const questions: string[] = [];
	return {
		questions,
		confirm: (question) => {
			questions.push(question);
			return answer;
		},
	};
}

function deps(runner: Runner = refuseToRun, confirm: CliDeps["confirm"] = terminal().confirm): CliDeps {
	return { runner, confirm };
}

/**
 * The test tree as the working directory's origin. Spelled from the adapter's own accepted host, so no
 * literal host reaches the identifier guard and the remote cannot drift from the one the read accepts.
 */
function inTestTree(answer: Runner): Runner {
	return answeringOrigin(`git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git`, answer);
}

describe("run, over a ticket set read from GitHub", () => {
	/**
	 * The limit the CLI has to be given for its argv to match the recording, which was captured asking for one
	 * row more than this — so `replayRunner` answers nothing if the over-fetch ever stops happening.
	 */
	const TREE = openIssues(GITHUB_TEST_TREE).length;

	/**
	 * Reads through `replayRunner`, so the argv the CLI builds has to be the captured one: this asserts what
	 * the command asks the tracker for — the state filter and the over-fetched row — and not only what it
	 * does with the answer.
	 */
	function readingTree(name: string): CliDeps {
		return deps(inTestTree(replayRunner([githubRecording(name)])));
	}

	function answering(name: string): CliDeps {
		return deps(inTestTree(respondingRunner(githubRecording(name))));
	}

	test("recommends the ticket the ladder chose, and accounts for the set it came from", () => {
		const result = run(["--limit", String(TREE)], readingTree("ticket-set"));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(shapeTitle(GITHUB_TEST_TREE, "several-priorities"));
		expect(result.stdout).toContain(`${TREE} tickets:`);
		expect(result.stdout).toContain("closed not asked");
		expect(result.stderr).toBe("");
	});

	// The tree carries one deliberate cycle, so this is the diagnostic against edges a tracker really
	// returned rather than against a hand-built graph. The numbers are not asserted: the tree is keyed by
	// shape and ADR-0023 says why a test may not claim an issue number.
	test("names the tree's blocking cycle, from the edges the tracker returned", () => {
		const result = run(["--limit", String(TREE)], readingTree("ticket-set"));
		const lines = deadlockLines(result.stdout);
		expect(lines).toHaveLength(1);

		const chain = lines[0]!.slice(DEADLOCK_PREFIX.length).split(", so ")[0]!.split(" blocked by ");
		expect(chain).toHaveLength(4);
		expect(new Set(chain).size).toBe(3);
		expect(chain[0]).toBe(chain[3]);
		expect(result.code).toBe(0);
	});

	test("bounds the read at a default of its own rather than at whatever the tracker CLI does", () => {
		const asked: string[][] = [];
		const result = run(
			[],
			deps(
				inTestTree((argv) => {
					asked.push(argv);
					return { code: 0, stdout: "[]", stderr: "" };
				}),
			),
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(String(DEFAULT_LIMIT + 1));
		expect(result.code).toBe(1);
	});

	test("carries a truncated read to the user, since a capped answer is a different answer", () => {
		const result = run(["--limit", "3"], readingTree("ticket-set-truncated"));
		expect(sentinelLines(result.stdout).some((line) => line.includes("truncated"))).toBe(true);
	});

	test("renders what the read itself could not answer, under the same sentinel as the selector's own", () => {
		const result = run(["--limit", String(TREE)], answering("ticket-set-without-blockers"));
		const lines = sentinelLines(result.stdout);
		expect(lines.some((line) => line.includes("did not report their blockers"))).toBe(true);
		expect(lines.some((line) => line.includes("blockers could be confirmed closed"))).toBe(true);
	});

	test("reports an unreachable tracker as a degraded answer with nothing to recommend", () => {
		const result = run([], answering("read-outage"));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
		expect(sentinelLines(result.stdout).some((line) => line.includes("could not be read"))).toBe(true);
		// The path where nothing was read at all, so the one a zero would misdescribe worst.
		expect(result.stdout).toContain("closed not asked");
	});

	test("refuses a read that is itself wrong, rather than reporting it as a quiet day", () => {
		const result = run([], answering("read-defect"));
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("a retry will not fix");
	});

	// The exit code is the point: an uncaught throw leaves 1, which this command defines as nothing to
	// recommend, so a run that failed would read to a script as a quiet day.
	test("still reports a failure nobody classified, keeping the stack that is all it has", () => {
		const broken: Runner = () => {
			throw new TypeError("undefined is not a function");
		};
		const result = run([], deps(broken));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("undefined is not a function");
		expect(result.stderr).toContain("at ");
	});

	test("refuses a response holding one issue twice as something needing a person", () => {
		const row = { number: 1, title: "A ticket", state: "OPEN", assignees: [], labels: [], url: "example/repo/issues/1", blockedBy: { nodes: [], totalCount: 0 } };
		const twice: Runner = () => ({ code: 0, stdout: JSON.stringify([row, row]), stderr: "" });
		const result = run([], deps(inTestTree(twice)));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("more than one row for");
	});

	test("refuses a working directory whose origin is not on GitHub", () => {
		const elsewhere = answeringOrigin("https://example.com/example/repo.git", () => ({ code: 0, stdout: "[]", stderr: "" }));
		const result = run([], deps(elsewhere));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("example.com");
	});

	test("emits the selection and the read's own degrades as JSON", () => {
		const clean = JSON.parse(run(["--limit", String(TREE), "--json"], readingTree("ticket-set")).stdout);
		expect(clean.selection.counts.closed).toBe("not-asked");
		expect(clean.selection.pick.title).toBe(shapeTitle(GITHUB_TEST_TREE, "several-priorities"));
		expect(clean.readDegraded).toEqual([]);

		const degraded = JSON.parse(run(["--limit", String(TREE), "--json"], answering("ticket-set-without-blockers")).stdout);
		expect(degraded.readDegraded).toEqual([{ kind: "unreadable-blocking", tickets: TREE, of: TREE }]);
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], deps());
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--include");
		expect(result.stdout).toContain("--json");
	});

	// The usage text spells the default exclusions out, so a fourth one added to the filter and not to the
	// prose leaves --help describing a filter the tool does not run, with nothing failing.
	//
	// Quoted as the text quotes them, not as bare words: `spec` is a substring of the "specification" two
	// lines below it, so a bare-word assertion holds over a usage text that has stopped naming the pattern.
	test("names every default exclusion it applies", () => {
		const result = run(["--help"], deps());
		for (const pattern of DEFAULT_LABEL_FILTER.exclude) expect(result.stdout).toContain(`'${pattern}'`);
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--include"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--include");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["gh:1"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("gh:1");
	});

	test("answers a help request even when another flag on the line is wrong", () => {
		for (const argv of [["--help", "--limit"], ["--limit", "--help"], ["--bogus", "-h"], ["--json", "-h"]]) {
			const result = run(argv, deps());
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("usage: nextup");
			expect(result.stderr).toBe("");
		}
	});

	test("reads a label that happens to be spelled like the help flag", () => {
		const result = run(["--include", "-h"], deps(inTestTree(() => ({ code: 0, stdout: "[]", stderr: "" }))));
		expect(result.stdout).not.toContain("usage: nextup");
		expect(result.code).toBe(1);
	});

	// The same word after a flag that could never use it. A limit is digits, so `-h` there is the help request
	// it looks like rather than a value, and skipping it made this the one bad-flag case help did not answer.
	test("answers help after a flag whose value it could not have been", () => {
		const result = run(["--limit", "-h"], deps());
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("usage: nextup");
	});

	// The guard against over-correcting: a bad limit that is not a help request is still a usage error.
	test("refuses a mistyped limit that asks for nothing", () => {
		const result = run(["--limit", "abc"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--limit");
	});

	test("refuses a limit no read could use, before any read happens", () => {
		expect(run(["--limit", "0"], deps()).code).toBe(2);
		expect(run(["--limit", "2.5"], deps()).stderr).toContain("--limit");
		expect(run(["--limit", "many"], deps()).stderr).toContain("--limit");
		// The read asks for one row more than this, which is past the range the adapter accepts at all.
		expect(run(["--limit", String(Number.MAX_SAFE_INTEGER)], deps()).stderr).toContain("--limit");
	});

	test("takes a limit as the digits it was given, not as whatever a number parse makes of them", () => {
		expect(run(["--limit", "0x10"], deps()).stderr).toContain("--limit");
		expect(run(["--limit", "1e3"], deps()).stderr).toContain("--limit");
	});

	test("refuses a pattern the grammar does not accept", () => {
		const result = run(["--exclude", "way*er"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("way*er");
	});
});
