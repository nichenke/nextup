import { describe, expect, test } from "bun:test";
import { type CliDeps, DEFAULT_LIMIT, run } from "./cli";
import { DEFAULT_SLASH_COMMAND } from "./command-builders";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import type { CommandResult, Runner } from "./runner";
import { DEADLOCK_PREFIX } from "./selection-output";
import { answeringOrigin, deadlockLines, githubRecording, replayRunner, respondingRunner, sentinelLines } from "./test-support";
import { GITHUB_TEST_TREE, type TestTreeSpec, openIssues, shapeTitle } from "./test-tree";
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

/**
 * A primary checkout that is deliberately not there. `ensure` asks the filesystem whether the worktree path
 * is occupied and whether the root is reached through a symlink, so the path has to be one where both
 * answers are settled — absent settles them, and a real temp directory would not: on macOS every path under
 * one is reached through a symlinked `/var`, which `ensure` refuses.
 */
const PRIMARY = "/nextup-not-a-real-checkout";

function deps(runner: Runner = refuseToRun, confirm: CliDeps["confirm"] = terminal().confirm): CliDeps {
	return { runner, confirm, cwd: PRIMARY };
}

/**
 * The test tree as the working directory's origin. Spelled from the adapter's own accepted host, so no
 * literal host reaches the identifier guard and the remote cannot drift from the one the read accepts.
 */
function inTestTree(answer: Runner): Runner {
	return answeringOrigin(`git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git`, answer);
}

/** How many of a tree's open issues the default filter refuses, so no test writes that number down. */
function excludedByDefault(tree: TestTreeSpec): number {
	const filter = compileLabelFilter(DEFAULT_LABEL_FILTER);
	return openIssues(tree).filter((issue) => !filter.admits(issue.labels)).length;
}

describe("run, over a ticket set read from GitHub", () => {
	/**
	 * The limit the CLI has to be given for its argv to match the recording, which was captured asking for one
	 * row more than this — so `replayRunner` answers nothing if the over-fetch ever stops happening.
	 */
	const TREE = openIssues(GITHUB_TEST_TREE).length;

	/**
	 * Stops a run once the pick is reported, for the tests here that reach a pick at all — the rest are
	 * refused or find nothing to recommend, and never get that far. Without it a run that picked something
	 * goes on to ask a workspace host, make a worktree and claim a ticket, so a test asserting a rendering
	 * would have to fake all three.
	 */
	const REPORT_ONLY = "--print-command";

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
		const result = run(["--limit", String(TREE), REPORT_ONLY], readingTree("ticket-set"));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(shapeTitle(GITHUB_TEST_TREE, "several-priorities"));
		expect(result.stdout).toContain(`${TREE} tickets:`);
		expect(result.stdout).toContain("closed not asked");
		// The count moved when `needs-triage` joined the defaults and no assertion here noticed, because none
		// named it at all.
		expect(result.stdout).toContain(`${excludedByDefault(GITHUB_TEST_TREE)} filtered out`);
		expect(result.stderr).toBe("");
	});

	// The tree carries one deliberate cycle, so this is the diagnostic against edges a tracker really
	// returned rather than against a hand-built graph. The numbers are not asserted: the tree is keyed by
	// shape and ADR-0023 says why a test may not claim an issue number.
	test("names the tree's blocking cycle, from the edges the tracker returned", () => {
		const result = run(["--limit", String(TREE), REPORT_ONLY], readingTree("ticket-set"));
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
		const result = run(["--limit", "3", REPORT_ONLY], readingTree("ticket-set-truncated"));
		expect(sentinelLines(result.stdout).some((line) => line.includes("truncated"))).toBe(true);
	});

	test("renders what the read itself could not answer, under the same sentinel as the selector's own", () => {
		const result = run(["--limit", String(TREE), REPORT_ONLY], answering("ticket-set-without-blockers"));
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
		const clean = JSON.parse(run(["--limit", String(TREE), "--json", REPORT_ONLY], readingTree("ticket-set")).stdout);
		expect(clean.selection.counts.closed).toBe("not-asked");
		expect(clean.selection.pick.title).toBe(shapeTitle(GITHUB_TEST_TREE, "several-priorities"));
		expect(clean.readDegraded).toEqual([]);

		const degraded = JSON.parse(run(["--limit", String(TREE), "--json", REPORT_ONLY], answering("ticket-set-without-blockers")).stdout);
		expect(degraded.readDegraded).toEqual([{ kind: "unreadable-blocking", tickets: TREE, of: TREE }]);
	});
});

/**
 * Every call the start sequence makes, answered by shape rather than by exact argv.
 *
 * By shape because the branch, and so most of these argv, are derived from the pick's own title and issue
 * number, which ADR-0023 says why a test may not claim. `replayRunner` is still what asserts the *read*'s argv;
 * what these tests assert is the sequence of writes, per the spec's one-injected-seam testing decision.
 */
function startSequence(over: (argv: string[]) => CommandResult | null = () => null, read = "ticket-set") {
	const calls: string[][] = [];
	const runner: Runner = (argv) => {
		calls.push(argv);
		const overridden = over(argv);
		if (overridden !== null) return overridden;
		if (argv[0] === "cmux") return { code: 0, stdout: argv[1] === "ping" ? "PONG\n" : "", stderr: "" };
		if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "edit") return { code: 0, stdout: "", stderr: "" };
		if (argv[0] === "gh") return respondingRunner(githubRecording(read))(argv);
		if (argv[0] !== "git") throw new Error(`nothing answers ${argv.join(" ")}`);
		if (argv.includes("get-url")) return { code: 0, stdout: `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git\n`, stderr: "" };
		if (argv.includes("list")) return { code: 0, stdout: `worktree ${PRIMARY}\0branch refs/heads/main\0\0`, stderr: "" };
		if (argv.includes("--git-common-dir")) return { code: 0, stdout: `${PRIMARY}/.git\n`, stderr: "" };
		if (argv.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
		// Present for origin/HEAD's target, absent for the ticket's own branch, which is what makes the run cut
		// a new one rather than adopt something.
		if (argv.includes("show-ref")) return { code: argv.includes("refs/remotes/origin/main") ? 0 : 1, stdout: "", stderr: "" };
		if (argv.includes("for-each-ref")) return { code: 0, stdout: "", stderr: "" };
		if (argv.includes("add")) return { code: 0, stdout: "", stderr: "" };
		throw new Error(`nothing answers ${argv.join(" ")}`);
	};
	const of = (...words: string[]) => calls.filter((argv) => words.every((word) => argv.includes(word)));
	const indexOf = (...words: string[]) => calls.findIndex((argv) => words.every((word) => argv.includes(word)));
	return { calls, runner, of, indexOf };
}

describe("starting work on the pick", () => {
	const TREE = openIssues(GITHUB_TEST_TREE).length;
	const LIMIT = ["--limit", String(TREE)];

	// ADR-0016, which is the reason this ordering has a test of its own rather than being implied by a
	// successful run: the worktree is the leftover a failure is allowed to have, so it goes first.
	test("makes the worktree, then claims, then starts the session — in that order", () => {
		const { runner, indexOf, of } = startSequence();
		const result = run([...LIMIT, "--yes"], deps(runner));

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const worktree = indexOf("worktree", "add");
		const claim = indexOf("issue", "edit");
		const session = indexOf("new-workspace");
		expect(worktree).toBeGreaterThan(-1);
		expect(worktree).toBeLessThan(claim);
		expect(claim).toBeLessThan(session);
		expect(of("new-workspace")).toHaveLength(1);
	});

	test("asks the workspace host before it writes anything at all", () => {
		const { runner, indexOf } = startSequence();
		run([...LIMIT, "--yes"], deps(runner));
		expect(indexOf("ping")).toBeLessThan(indexOf("worktree", "add"));
	});

	test("runs the session in the worktree it just made, under the default verb", () => {
		const { runner, of } = startSequence();
		run([...LIMIT, "--yes"], deps(runner));
		const [created] = of("worktree", "add");
		const [workspace] = of("new-workspace");
		const path = created![created!.indexOf("add") + 1];
		expect(workspace![workspace!.indexOf("--cwd") + 1]).toBe(path);
		expect(workspace![workspace!.indexOf("--command") + 1]).toContain(DEFAULT_SLASH_COMMAND);
	});

	test("runs the verb it was given instead", () => {
		const { runner, of } = startSequence();
		run([...LIMIT, "--yes", "--slash-command", "/triage"], deps(runner));
		const [workspace] = of("new-workspace");
		expect(workspace![workspace!.indexOf("--command") + 1]).toContain("/triage");
	});

	test("reports the worktree, the claim and the session it started", () => {
		const { runner } = startSequence();
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.stdout).toContain("claimed ");
		expect(result.stdout).toContain("started claude ");
	});

	/**
	 * The `start` object is what README and --help tell a script to read, so it is a contract rather than a
	 * convenience — and every reference in it has to be the short form, since a raw `{tracker, repo, host, key}`
	 * reaching a consumer is the shape `CandidateJson` exists to prevent.
	 */
	test("carries what it started under --json, with references in their short form", () => {
		const { runner } = startSequence();
		const document = JSON.parse(run([...LIMIT, "--yes", "--json"], deps(runner)).stdout);

		expect(document.start.kind).toBe("started");
		expect(typeof document.start.ref).toBe("string");
		expect(document.start.ref).toBe(document.selection.pick.ref);
		expect(document.start.command[0]).toBe("claude");
		expect(document.start.worktree.path).toContain(`${PRIMARY}/.worktrees/`);
		expect(document.start.worktree.kind).toBe("created");
	});

	test("names the other outcomes under --json too, so a script can tell them apart", () => {
		const printed = JSON.parse(run([...LIMIT, "--print-command", "--json"], deps(startSequence().runner)).stdout);
		expect(printed.start).toEqual({ kind: "printed", command: ["claude", printed.start.command[1]] });

		const declined = JSON.parse(
			run([...LIMIT, "--json"], { runner: startSequence().runner, confirm: terminal(false).confirm, cwd: PRIMARY }).stdout,
		);
		expect(declined.start.kind).toBe("declined");
		expect(typeof declined.start.ref).toBe("string");

		const nothing = JSON.parse(run(["--json"], deps(inTestTree(() => ({ code: 0, stdout: "[]", stderr: "" })))).stdout);
		expect(nothing.start).toEqual({ kind: "nothing-to-start" });
	});
});

describe("the confirmation gate", () => {
	const TREE = openIssues(GITHUB_TEST_TREE).length;
	const LIMIT = ["--limit", String(TREE)];

	test("names the pick in the question, since the rendering it is about has not been printed yet", () => {
		const { runner } = startSequence();
		const asked = terminal();
		const result = run(LIMIT, { runner, confirm: asked.confirm, cwd: PRIMARY });
		expect(asked.questions).toHaveLength(1);
		expect(asked.questions[0]).toContain(shapeTitle(GITHUB_TEST_TREE, "several-priorities"));
		expect(asked.questions[0]).toContain("[y/N]");
		expect(result.code).toBe(0);
	});

	/**
	 * Asserted on both states rather than only on unknown: a phrase present for one alone would make its
	 * absence the signal, which is the same collapse spelled the other way. `blockingPhrase` has why the gate
	 * is where this matters.
	 */
	test("names the pick's blocking state in the question, whichever state it is", () => {
		const confirmed = terminal();
		run(LIMIT, { runner: startSequence().runner, confirm: confirmed.confirm, cwd: PRIMARY });
		expect(confirmed.questions[0]).toContain("blockers confirmed closed");

		const blind = terminal();
		const { runner } = startSequence(() => null, "ticket-set-without-blockers");
		run(LIMIT, { runner, confirm: blind.confirm, cwd: PRIMARY });
		expect(blind.questions).toHaveLength(1);
		expect(blind.questions[0]).toContain("blockers unknown");
		expect(blind.questions[0]).not.toContain("blockers confirmed closed");
	});

	// The same property one caveat over: a pick from a capped read may be beaten by a ticket nobody looked at,
	// and the operator would learn that from a line printed after they had already claimed it.
	test("carries the answer's other caveats too, not only the blocking state", () => {
		const asked = terminal();
		const { runner } = startSequence(() => null, "ticket-set-truncated");
		run(["--limit", "3"], { runner, confirm: asked.confirm, cwd: PRIMARY });
		expect(asked.questions).toHaveLength(1);
		expect(asked.questions[0]).toContain("truncated");
	});

	test("writes nothing when the answer is no, and says so", () => {
		const { runner, of } = startSequence();
		const result = run(LIMIT, { runner, confirm: terminal(false).confirm, cwd: PRIMARY });
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
		expect(of("new-workspace")).toEqual([]);
		expect(result.stdout).toContain("was not started");
		expect(result.code).toBe(0);
	});

	test("does not ask when --yes answered in advance", () => {
		const { runner } = startSequence();
		const asked = terminal();
		run([...LIMIT, "--yes"], { runner, confirm: asked.confirm, cwd: PRIMARY });
		expect(asked.questions).toEqual([]);
	});

	test("refuses a run with nobody to ask and no --yes", () => {
		const { runner, of } = startSequence();
		const result = run(LIMIT, { runner, confirm: null, cwd: PRIMARY });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--yes");
		expect(of("worktree", "add")).toEqual([]);
	});
});

describe("--print-command", () => {
	const LIMIT = ["--limit", String(openIssues(GITHUB_TEST_TREE).length)];

	test("prints the session command and creates, claims and starts nothing", () => {
		const { runner, calls } = startSequence();
		const result = run([...LIMIT, "--print-command"], deps(runner));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`claude '${DEFAULT_SLASH_COMMAND} `);
		expect(calls.filter((argv) => argv[0] !== "git" && argv[1] !== "list")).toHaveLength(1);
	});

	// The sandbox-safe path per ADR-0002, which it would not be if it needed the host it cannot reach.
	test("never asks the workspace host, and never asks a person", () => {
		const { runner, of } = startSequence();
		const asked = terminal();
		run([...LIMIT, "--print-command"], { runner, confirm: asked.confirm, cwd: PRIMARY });
		expect(of("ping")).toEqual([]);
		expect(asked.questions).toEqual([]);
	});
});

describe("a start that could not finish", () => {
	const LIMIT = ["--limit", String(openIssues(GITHUB_TEST_TREE).length)];

	test("refuses a dead workspace host before the worktree and the claim", () => {
		const { runner, of } = startSequence((argv) =>
			argv[1] === "ping" ? { code: 1, stdout: "", stderr: "connect: no such file or directory" } : null,
		);
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--print-command");
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
	});

	test("names the worktree it left behind when the claim will not land", () => {
		const { runner, of } = startSequence((argv) =>
			argv[2] === "edit" ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } : null,
		);
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("running this again");
		expect(result.stderr).toContain(`${PRIMARY}/.worktrees/`);
		expect(of("new-workspace")).toEqual([]);
	});

	// The re-run wording is asserted absent, not merely the new wording present: ADR-0035 has why saying it here
	// would send an operator to start the wrong ticket.
	test("hands over the session command when the workspace fails after the claim landed", () => {
		const { runner, of } = startSequence((argv) =>
			argv[1] === "new-workspace" ? { code: 1, stdout: "", stderr: "no window" } : null,
		);
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(of("issue", "edit")).toHaveLength(1);
		expect(result.stderr).not.toContain("running this again");
		expect(result.stderr).toContain("would pick a different ticket");
		expect(result.stderr).toContain(`cd ${PRIMARY}/.worktrees/`);
		expect(result.stderr).toContain("claude '/implement ");
	});

	test("reports a worktree that could not be made, and claims nothing", () => {
		const { runner, of } = startSequence((argv) =>
			argv.includes("add") ? { code: 128, stdout: "", stderr: "fatal: invalid reference" } : null,
		);
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("could not be created");
		expect(of("issue", "edit")).toEqual([]);
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
