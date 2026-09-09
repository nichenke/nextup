import { describe, expect, test } from "bun:test";
import { type CliDeps, DEFAULT_LIMIT, run } from "./cli";
import { type Runner, RunnerRefusal } from "./runner";
import { githubRecording, replayRunner, respondingRunner, sentinelLines } from "./test-support";
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
 * A runner answering the repository question from the working directory, and everything else from `answer`.
 * The origin is spelled from the adapter's own accepted host, so no literal host reaches the identifier
 * guard and the remote cannot drift from the one the read accepts.
 */
function inTestTree(answer: Runner): Runner {
	const origin = `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git`;
	return (argv) => (argv[0] === "git" ? { code: 0, stdout: `${origin}\n`, stderr: "" } : answer(argv));
}

describe("run, over a ticket set read from GitHub", () => {
	/** Has to match the limit the recording was captured under, or `replayRunner` answers nothing. */
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
		expect(result.stderr).toBe("");
	});

	test("says the closed count was never asked for, rather than reporting a zero", () => {
		expect(run(["--limit", String(TREE)], readingTree("ticket-set")).stdout).toContain("closed not asked");
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
	});

	test("refuses a read that is itself wrong, rather than reporting it as a quiet day", () => {
		const result = run([], answering("read-defect"));
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("a retry will not fix");
	});

	// The exit code is the point in both of these: an uncaught throw leaves 1, which this command defines as
	// nothing to recommend, so a run that failed would read to a script as a quiet day.
	test("reports a runner that refuses to run at all as its recovery path, not as a stack", () => {
		// What `defaultRunner` does when the environment points git elsewhere — ADR-0026.
		const refusing: Runner = () => {
			throw new RunnerRefusal("GIT_DIR is set: unset it and run again");
		};
		const result = run([], deps(refusing));
		expect(result.code).toBe(2);
		expect(result.stderr).toBe("GIT_DIR is set: unset it and run again\n");
	});

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
		expect(result.stderr).toContain("no blocking graph could be built over");
	});

	test("refuses a working directory whose origin is not on GitHub", () => {
		const elsewhere: Runner = (argv) =>
			argv[0] === "git"
				? { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" }
				: { code: 0, stdout: "[]", stderr: "" };
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
