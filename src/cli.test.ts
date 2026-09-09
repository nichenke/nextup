import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, DEFAULT_LIMIT, run } from "./cli";
import { loadRecording, recordingsDir } from "./recording";
import type { Runner } from "./runner";
import { DEGRADED_PREFIX } from "./selection-output";
import { replayRunner, respondingRunner } from "./test-support";
import { GITHUB_TEST_TREE } from "./test-tree";
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

function deps(cwd: string, runner: Runner = refuseToRun, confirm: CliDeps["confirm"] = terminal().confirm): CliDeps {
	return { cwd, runner, confirm };
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

function recording(name: string) {
	return loadRecording(join(recordingsDir("github"), `${name}.json`));
}

function sentinels(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith(DEGRADED_PREFIX));
}

function titleOf(key: string): string {
	const issue = GITHUB_TEST_TREE.issues.find((one) => one.key === key);
	if (issue === undefined) throw new Error(`${key} is not a shape the test tree carries`);
	return issue.title;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "nextup-cli-"));
	roots.push(root);
	return root;
}

describe("run, over a ticket set read from GitHub", () => {
	/** The recorded read's own limit: the tree's open issues, which is every row it returns. */
	const TREE = GITHUB_TEST_TREE.issues.filter((one) => !one.closed).length;

	/**
	 * Reads through `replayRunner`, so the argv the CLI builds has to be the captured one: this asserts what
	 * the command asks the tracker for — the state filter and the over-fetched row — and not only what it
	 * does with the answer.
	 */
	function readingTree(name: string): CliDeps {
		return deps(tempRepo(), inTestTree(replayRunner([recording(name)])));
	}

	function answering(name: string): CliDeps {
		return deps(tempRepo(), inTestTree(respondingRunner(recording(name))));
	}

	test("recommends the ticket the ladder chose, and accounts for the set it came from", () => {
		const result = run(["--limit", String(TREE)], readingTree("ticket-set"));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(titleOf("several-priorities"));
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
				tempRepo(),
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
		expect(sentinels(result.stdout).some((line) => line.includes("truncated"))).toBe(true);
	});

	test("renders what the read itself could not answer, under the same sentinel as the selector's own", () => {
		const result = run(["--limit", String(TREE)], answering("ticket-set-without-blockers"));
		const lines = sentinels(result.stdout);
		expect(lines.some((line) => line.includes("did not report their blockers"))).toBe(true);
		expect(lines.some((line) => line.includes("blockers could be confirmed closed"))).toBe(true);
	});

	test("reports an unreachable tracker as a degraded answer with nothing to recommend", () => {
		const result = run([], answering("read-outage"));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
		expect(sentinels(result.stdout).some((line) => line.includes("could not be read"))).toBe(true);
	});

	test("refuses a read that is itself wrong, rather than reporting it as a quiet day", () => {
		const result = run([], answering("read-defect"));
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("a retry will not fix");
	});

	test("refuses a working directory whose origin is not on GitHub", () => {
		const elsewhere: Runner = (argv) =>
			argv[0] === "git"
				? { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" }
				: { code: 0, stdout: "[]", stderr: "" };
		const result = run([], deps(tempRepo(), elsewhere));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("example.com");
	});

	test("emits the selection and the read's own degrades as JSON", () => {
		const clean = JSON.parse(run(["--limit", String(TREE), "--json"], readingTree("ticket-set")).stdout);
		expect(clean.selection.counts.closed).toBe("not-asked");
		expect(clean.selection.pick.title).toBe(titleOf("several-priorities"));
		expect(clean.readDegraded).toEqual([]);

		const degraded = JSON.parse(run(["--limit", String(TREE), "--json"], answering("ticket-set-without-blockers")).stdout);
		expect(degraded.readDegraded).toEqual([{ kind: "unreadable-blocking", tickets: TREE, of: TREE }]);
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], deps(tempRepo()));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--include");
		expect(result.stdout).toContain("--json");
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--include"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--include");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["gh:1"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("gh:1");
	});

	test("refuses a limit no read could use, before any read happens", () => {
		expect(run(["--limit", "0"], deps(tempRepo())).code).toBe(2);
		expect(run(["--limit", "2.5"], deps(tempRepo())).stderr).toContain("--limit");
		expect(run(["--limit", "many"], deps(tempRepo())).stderr).toContain("--limit");
	});

	test("refuses a pattern the grammar does not accept", () => {
		const result = run(["--exclude", "way*er"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("way*er");
	});
});
