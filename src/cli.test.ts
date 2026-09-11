import { describe, expect, test } from "bun:test";
import { type CliDeps, DEFAULT_LIMIT, run } from "./cli";
import { DEFAULT_SLASH_COMMAND } from "./command-builders";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "./label-filter";
import type { CommandResult, Runner } from "./runner";
import { FORCED_PREFIX } from "./override-output";
import { DEADLOCK_PREFIX } from "./selection-output";
import {
	answeringOrigin,
	deadlockLines,
	githubRecording,
	recordedIssue,
	replayRunner,
	respondingRunner,
	sentinelLines,
} from "./test-support";
import { GITHUB_TEST_TREE, type TestTreeSpec, openIssues, shapeTitle } from "./test-tree";
import { GITHUB_HOST } from "./repo-address";

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
function startSequence(
	over: (argv: string[]) => CommandResult | null = () => null,
	read = "ticket-set",
	primary = PRIMARY,
) {
	const calls: string[][] = [];
	const runner: Runner = (argv) => {
		calls.push(argv);
		const overridden = over(argv);
		if (overridden !== null) return overridden;
		if (argv[0] === "cmux") return { code: 0, stdout: argv[1] === "ping" ? "PONG\n" : "", stderr: "" };
		if (argv[0] === "claude") return { code: 0, stdout: "0.0.0 (test)\n", stderr: "" };
		if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "edit") return { code: 0, stdout: "", stderr: "" };
		if (argv[0] === "gh") return respondingRunner(githubRecording(read))(argv);
		if (argv[0] !== "git") throw new Error(`nothing answers ${argv.join(" ")}`);
		if (argv.includes("get-url")) return { code: 0, stdout: `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git\n`, stderr: "" };
		if (argv.includes("list")) return { code: 0, stdout: `worktree ${primary}\0branch refs/heads/main\0\0`, stderr: "" };
		if (argv.includes("--git-common-dir")) return { code: 0, stdout: `${primary}/.git\n`, stderr: "" };
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

	/**
	 * The ranked path's only checkout comparison, and the reason `requireThisCheckout` lives in the claim rather
	 * than beside the named-ticket check that looks like its duplicate.
	 *
	 * A repository renamed on GitHub with a stale local remote reaches here: the read asks under the old name,
	 * GitHub redirects, and `requireOneRepository` deliberately tolerates rows answering under the new one. So
	 * every ranked reference names a repository this checkout does not, nothing upstream compares them, and the
	 * claim is what refuses. The remedy is to correct the remote, which is what the message names. ADR-0039.
	 */
	test("refuses to claim a ranked ticket whose rows name a repository this checkout is not", () => {
		const renamed = (argv: string[]): CommandResult | null => {
			if (argv[0] !== "git" || !argv.includes("get-url")) return null;
			return { code: 0, stdout: `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo.replace(/[^/]+$/, "old-name")}.git\n`, stderr: "" };
		};
		const asked = terminal(true);
		const { runner, of } = startSequence(renamed);
		const result = run([...LIMIT], deps(runner, asked.confirm));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("old-name");
		expect(result.stderr).toContain(GITHUB_TEST_TREE.repo);
		// Neither write, and nobody asked: the comparison reads one local git command and settles whether the run
		// can happen, so it comes before the host is pinged and before a person is asked to confirm.
		expect(asked.questions).toEqual([]);
		expect(of("ping")).toEqual([]);
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
	});

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
		expect(result.stdout).toContain("asked cmux to run claude ");
	});

	/**
	 * The `start` object is what README and --help tell a script to read, so it is a contract rather than a
	 * convenience — and every reference in it has to be the short form, since a raw `{tracker, repo, host, key}`
	 * reaching a consumer is the shape `CandidateJson` exists to prevent.
	 */
	test("carries what it started under --json, with references in their short form", () => {
		const { runner } = startSequence();
		const document = JSON.parse(run([...LIMIT, "--yes", "--json"], deps(runner)).stdout);

		expect(document.start.kind).toBe("requested");
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

	/**
	 * Having nobody to ask is decidable from the invocation, so it is settled before the host is contacted. Asked
	 * in the other order, an unattended run against a stopped host would blame the host and say to run it again —
	 * which refuses identically, for a reason that message never names.
	 */
	test("blames the missing terminal rather than the host, and does not contact the host at all", () => {
		const { runner, of } = startSequence((argv) =>
			argv[1] === "ping" ? { code: 1, stdout: "", stderr: "connect: no such file or directory" } : null,
		);
		const result = run(LIMIT, { runner, confirm: null, cwd: PRIMARY });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--yes");
		expect(result.stderr).not.toContain("workspace host");
		expect(of("ping")).toEqual([]);
	});
});

describe("--print-command", () => {
	const LIMIT = ["--limit", String(openIssues(GITHUB_TEST_TREE).length)];

	test("prints the session command and creates, claims and starts nothing", () => {
		const { runner, calls } = startSequence();
		const result = run([...LIMIT, "--print-command"], deps(runner));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`claude '${DEFAULT_SLASH_COMMAND} `);
		expect(calls.filter((argv) => argv[0] !== "git")).toHaveLength(1);
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
		expect(result.stderr).toContain("no such file or directory");
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
		// The claim state as well as the recovery: a ranked pick is unclaimed by construction, and this is the
		// sentence that tells the operator what the tracker holds.
		expect(result.stderr).toContain("the ticket is still unclaimed");
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

	/**
	 * ADR-0036: the host accepts a command without reporting whether it ran, so a binary that will not run would
	 * otherwise reach a claimed ticket and a run reporting that it asked for a session.
	 */
	test("refuses a session binary that will not run, before the worktree and the claim", () => {
		const { runner, of } = startSequence((argv) =>
			argv[0] === "claude" ? { code: 127, stdout: "", stderr: "command not found: claude" } : null,
		);
		const result = run([...LIMIT, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("command not found");
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
		expect(of("new-workspace")).toEqual([]);
	});

	/**
	 * The handover is the only recovery offered once the claim has landed, so it has to survive a checkout path
	 * holding a space — which is ordinary on macOS, not exotic. Unquoted, `cd` took the first word and the
	 * operator was sent somewhere else entirely.
	 */
	test("quotes the worktree path in that handover, so a path with a space still works", () => {
		const spaced = "/nextup not a real checkout";
		const { runner } = startSequence(
			(argv) => (argv[1] === "new-workspace" ? { code: 1, stdout: "", stderr: "no window" } : null),
			"ticket-set",
			spaced,
		);
		const result = run([...LIMIT, "--yes"], { runner, confirm: terminal().confirm, cwd: spaced });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(`cd '${spaced}/.worktrees/`);
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

	test("refuses a bare argument that is not a ticket reference", () => {
		const result = run(["ticket-12"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("ticket-12");
	});

	test("refuses two tickets, since a run starts one", () => {
		const result = run(["gh:1", "gh:2"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("gh:2");
	});

	test("refuses the ticket-set flags beside a named ticket, rather than ignoring them", () => {
		for (const flag of [["--limit", "5"], ["--include", "bug"], ["--exclude", "spec"]]) {
			const result = run([...flag, "gh:example/repo#1"], deps());
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(flag[0]!);
		}
	});

	test("refuses --force with no ticket to apply it to", () => {
		const result = run(["--force"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--force");
	});

	// The other arm of the same rule: --print-command runs no check on the named ticket, so --force clears nothing.
	test("refuses --force beside --print-command, which checks nothing for it to clear", () => {
		const result = run(["gh:example/repo#1", "--force", "--print-command"], deps());
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--force");
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

describe("starting a ticket named on the command line", () => {
	/** The named form for one view recording's issue, which has to be the issue that recording answers about. */
	function named(recording = "ticket-view"): string {
		return `gh:${GITHUB_TEST_TREE.repo}#${recordedIssue(githubRecording(recording))}`;
	}

	function starting(recording: string, over: (argv: string[]) => CommandResult | null = () => null) {
		return startSequence(over, recording);
	}

	test("starts the named ticket, reading one ticket rather than ranking a set", () => {
		const { runner, of } = starting("ticket-view");
		const result = run([named(), "--yes"], deps(runner));

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(shapeTitle(GITHUB_TEST_TREE, "every-blocker-closed"));
		expect(result.stdout).toContain("named directly");
		// The ranking is not merely unused: no set is read at all, which is what naming a ticket buys.
		expect(of("issue", "list")).toEqual([]);
		expect(of("issue", "view")).toHaveLength(1);
		expect(of("worktree", "add")).toHaveLength(1);
		expect(of("issue", "edit")).toHaveLength(1);
	});

	test("refuses a ticket with an open blocker, naming it, and writes nothing", () => {
		const { runner, of } = starting("ticket-view-blocked");
		const result = run([named("ticket-view-blocked"), "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("blocked by");
		expect(result.stderr).toContain("--force");
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
	});

	test("refuses a ticket somebody else holds, and writes nothing", () => {
		const { runner, of } = starting("ticket-view-claimed");
		const result = run([named("ticket-view-claimed"), "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("claimed by");
		expect(of("issue", "edit")).toEqual([]);
	});

	// nichenke/nextup issue 12's fourth criterion, which ADR-0037 has the reasoning for.
	test("--force starts a blocked ticket, says so loudly, and claims it anyway", () => {
		const { runner, of } = starting("ticket-view-blocked");
		const result = run([named("ticket-view-blocked"), "--force", "--yes"], deps(runner));

		expect(result.code).toBe(0);
		const forced = result.stdout.split("\n").filter((line) => line.startsWith(FORCED_PREFIX));
		expect(forced).toHaveLength(1);
		expect(forced[0]).toContain("blocked by");
		expect(of("issue", "edit")).toHaveLength(1);
	});

	test("--force starts a claimed ticket, and the claim it writes does not replace the existing one", () => {
		const { runner, of } = starting("ticket-view-claimed");
		const result = run([named("ticket-view-claimed"), "--force", "--yes"], deps(runner));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${FORCED_PREFIX}`);
		expect(of("issue", "edit")[0]).toContain("--add-assignee");
	});

	// ADR-0037, whose decision `override.test.ts` states beside its own test of it.
	test("refuses a closed ticket, and --force does not reach it", () => {
		const { runner, of } = starting("ticket-view-closed");
		for (const argv of [[named("ticket-view-closed"), "--yes"], [named("ticket-view-closed"), "--force", "--yes"]]) {
			const result = run(argv, deps(runner));
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("closed");
		}
		expect(writes(of)).toEqual([]);
	});

	/** Both writes, asserted together: a refusal has to leave the tracker and the repository as they were. */
	function writes(of: (...words: string[]) => string[][]): string[][] {
		return [...of("worktree", "add"), ...of("issue", "edit")];
	}

	test("asks before a forced start, so the warning is read before the claim rather than after", () => {
		const asked = terminal(false);
		const { runner, of } = starting("ticket-view-blocked");
		const outcome = run([named("ticket-view-blocked"), "--force"], deps(runner, asked.confirm));

		expect(outcome.code).toBe(0);
		expect(asked.questions).toHaveLength(1);
		expect(asked.questions[0]).toContain("starting past it being");
		expect(outcome.stdout).toContain("was not started");
		expect(of("issue", "edit")).toEqual([]);
	});

	/**
	 * A runner answering the one question that is not a tracker read — which repository this checkout is — and
	 * refusing everything else, so a test using it proves no tracker was contacted.
	 */
	const gitOnly: Runner = (argv) => {
		if (argv[0] === "git" && argv.includes("get-url")) {
			return { code: 0, stdout: `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo}.git\n`, stderr: "" };
		}
		throw new Error(`nothing may run ${argv.join(" ")} for a command that only prints`);
	};

	test("prints the session command for a named ticket without contacting any tracker", () => {
		const result = run([named(), "--print-command"], deps(gitOnly));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${DEFAULT_SLASH_COMMAND} ${named()}`);
		expect(result.stderr).toBe("");
	});

	test("carries the override and what the run did about it under --json", () => {
		const { runner } = starting("ticket-view");
		const result = run([named(), "--force", "--yes", "--json"], deps(runner));
		const answer = JSON.parse(result.stdout) as {
			override: { kind: string; target: { ticket: { ref: string }; blocked: string }; forced: unknown[] };
			readDegraded: unknown[];
			start: { kind: string };
		};

		expect(answer.override.kind).toBe("startable");
		expect(answer.override.target.ticket.ref).toBe(named());
		expect(answer.override.target.blocked).toBe("unblocked");
		// Nothing needed clearing, so --force reports nothing: the warning is never spurious.
		expect(answer.override.forced).toEqual([]);
		expect(answer.readDegraded).toEqual([]);
		expect(answer.start.kind).toBe("requested");
	});

	// A refusal is an answer rather than a failure — the checks ran and said no — so a consumer asking for JSON
	// gets the document rather than prose it would have to parse, and the exit status tells the two apart.
	test("carries a refusal as the same JSON document a started run gets", () => {
		const { runner } = starting("ticket-view-blocked");
		const result = run([named("ticket-view-blocked"), "--yes", "--json"], deps(runner));
		const answer = JSON.parse(result.stdout) as {
			override: { kind: string; refusals: { kind: string; blockers?: string[] }[] };
			start: unknown;
		};

		expect(result.code).toBe(2);
		expect(result.stderr).toBe("");
		expect(answer.override.kind).toBe("refused");
		expect(answer.override.refusals.map((refusal) => refusal.kind)).toEqual(["blocked"]);
		expect(answer.override.refusals[0]!.blockers?.[0]).toStartWith("gh:");
		// Null rather than an absent key, and never an arm claiming something was started.
		expect(answer.start).toBeNull();
	});

	// "Reads nothing" is not "accepts anything": the reference is still checked, because a command printed for a
	// tracker with no adapter, or for a key every other path refuses, is not one of the things this may print.
	test("refuses a reference no adapter can act on even where it prints without reading", () => {
		for (const reference of ["jira:TEST-7", `gh:${GITHUB_TEST_TREE.repo}#012`]) {
			const result = run([reference, "--print-command"], deps(gitOnly));
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
		}
	});

	/**
	 * The recovery a failed claim leaves open has to describe the tracker, not a ranked pick's assumptions: a forced
	 * start overruled a claim that is still the only one on the ticket.
	 */
	test("does not call a forced ticket unclaimed when its claim failed", () => {
		const { runner, of } = starting("ticket-view-claimed", (argv) =>
			argv[1] === "issue" && argv[2] === "edit" ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } : null,
		);
		const result = run([named("ticket-view-claimed"), "--force", "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).not.toContain("still unclaimed");
		expect(result.stderr).toContain("still claimed");
		// Named as one assignee among any others, never as the only one: `readClaim` keeps the first of them and
		// says that which one it reports is display, so a count is not a thing a `Claim` can support.
		expect(result.stderr).toContain("among its assignees");
		expect(result.stderr).not.toContain("only one");
		// The worktree is the leftover a failed claim is allowed to have, and the message has to name it.
		expect(result.stderr).toContain(".worktrees");
		expect(of("worktree", "add")).toHaveLength(1);
	});

	/**
	 * The recovery a failed session leaves a named ticket: the command, and no guess about a re-run. What one would
	 * do turns on whether the line carried `--force`, so the prediction is absent by design rather than missing.
	 */
	test("offers the command and predicts nothing about a re-run, for a named ticket", () => {
		for (const flags of [["--yes"], ["--force", "--yes"]]) {
			const { runner } = starting("ticket-view", (argv) =>
				argv[1] === "new-workspace" ? { code: 1, stdout: "", stderr: "no window" } : null,
			);
			const result = run([named(), ...flags], deps(runner));

			expect(result.code).toBe(2);
			expect(result.stderr).not.toContain("pick a different ticket");
			expect(result.stderr).not.toContain("Running this again");
			expect(result.stderr).toContain("Start this session yourself instead");
			expect(result.stderr).toContain("cd ");
		}
	});

	test("reports a ticket the tracker does not have as something for a person, not as a quiet day", () => {
		const { runner } = starting("ticket-view-defect");
		const result = run([`gh:${GITHUB_TEST_TREE.repo}#999999`, "--yes"], deps(runner));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("retry will not fix");
		// A failure of the read itself is not a bad invocation, so it keeps its own report rather than the usage
		// the mistyped-key branch above prints.
		expect(result.stderr).not.toContain("usage: nextup");
	});

	/**
	 * A padded key is a reference naming one issue and addressing another — nichenke/nextup issue 56 — and on
	 * this path it is a typo, so what a person needs is the accepted forms rather than the builder's stack.
	 *
	 * The short form only, though both URL patterns capture a padded number just as readily. Every form reaches
	 * the same refusal, in `githubIssueViewCommand`, because the reference is resolved before the read and the
	 * read builds one argv — so a second case here would assert the resolver's captures rather than this
	 * classification, and those belong to issue 56 and `ticket-ref.test.ts`.
	 */
	test("refuses a zero-padded key as a bad invocation, before any call goes out", () => {
		const result = run([`gh:${GITHUB_TEST_TREE.repo}#012`], deps(gitOnly));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("canonical");
		expect(result.stderr).toContain("usage: nextup");
		expect(result.stderr).not.toContain("    at ");
	});

	/**
	 * The path alone is not the repository: `owner/repo` exists on every host, and a reference carries no host of
	 * its own in the short form. Matching on the path would claim on github.com from a checkout that lives
	 * somewhere else entirely — the same hazard ADR-0032 records for the claim, reached by another route.
	 */
	test("refuses a GitHub ticket from a checkout whose remote is on another host", () => {
		// The path matches and only the host differs, so this reaches the host check rather than the path one. The
		// remote is spelled as the allowlisted synthetic one, which the identifier guard already accepts.
		const elsewhere: Runner = (argv) => {
			if (argv[0] === "git" && argv.includes("get-url")) {
				return { code: 0, stdout: "https://example.com/example/repo.git\n", stderr: "" };
			}
			throw new Error(`nothing may run ${argv.join(" ")} for a checkout on another host`);
		};
		const result = run(["gh:example/repo#1", "--yes"], deps(elsewhere));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("example.com");
		expect(result.stderr).not.toContain("usage: nextup");
	});

	// A tracker resolves the path case-insensitively, so a remote spelling it differently is this repository —
	// refusing it would send the operator to the checkout they are already standing in.
	test("accepts a named ticket whose repository the remote spells in another case", () => {
		const shouted: Runner = (argv) =>
			argv[0] === "git" && argv.includes("get-url")
				? { code: 0, stdout: `git@${GITHUB_HOST}:${GITHUB_TEST_TREE.repo.toUpperCase()}.git\n`, stderr: "" }
				: { code: 1, stdout: "", stderr: "nothing else should be reached" };
		const result = run([`gh:${GITHUB_TEST_TREE.repo}#1`, "--print-command"], deps(shouted));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(DEFAULT_SLASH_COMMAND);
	});

	/**
	 * The checkout boundary is checked before the read, against the reference as typed — but the claim is written
	 * with the reference the *response* carried, which `readRow` builds from the issue's own address. An issue
	 * transferred to another repository that lands on the same number would otherwise pass the number check, and
	 * the claim would go there while the worktree was made here.
	 */
	test("refuses a response naming another repository, even at the number asked for", () => {
		const elsewhere = (argv: string[]): CommandResult | null => {
			if (argv[0] !== "gh" || argv[2] !== "view") return null;
			const row = {
				number: 1,
				title: "an issue that moved",
				state: "OPEN",
				assignees: [],
				labels: [],
				url: "example/repo/issues/1",
				blockedBy: { nodes: [], totalCount: 0 },
			};
			return { code: 0, stdout: JSON.stringify(row), stderr: "" };
		};
		const { runner, of } = starting("ticket-view", elsewhere);
		const result = run([`gh:${GITHUB_TEST_TREE.repo}#1`, "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("example/repo");
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
	});

	/**
	 * The arm that decides what happens when the comparison itself cannot be made. Refused rather than allowed
	 * through: a reference that may or may not belong to this checkout is not one to start work on, and the
	 * alternative fails in the direction that splits the two writes across repositories.
	 */
	test("refuses a named ticket when this checkout's own remote cannot be resolved", () => {
		const noRemote: Runner = (argv) => {
			if (argv[0] === "git" && argv.includes("get-url")) return { code: 1, stdout: "", stderr: "fatal: No such remote 'origin'\n" };
			throw new Error(`nothing may run ${argv.join(" ")} once the remote is unresolvable`);
		};
		const result = run(["gh:example/repo#1", "--yes"], deps(noRemote));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("could not be resolved");
		expect(result.stderr).not.toContain("usage: nextup");
	});

	/**
	 * The other accepted form, end to end. The URL's host is what says which tracker it belongs to, so resolving one
	 * asks the two CLIs which hosts they are authenticated to — `glab` answering no is what disambiguates.
	 *
	 * Joined rather than spelled whole: the identifier guard reads a literal URL as an identifier, and `CLAUDE.md`
	 * has the rule.
	 */
	test("starts a ticket named by a pasted issue URL", () => {
		const number = recordedIssue(githubRecording("ticket-view"));
		const pasted = ["https:/", GITHUB_HOST, GITHUB_TEST_TREE.repo, "issues", number].join("/");
		const { runner, of } = starting("ticket-view", (argv) =>
			argv[0] === "glab" ? { code: 1, stdout: "", stderr: "not authenticated" } : null,
		);
		const result = run([pasted, "--yes"], deps(runner));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(shapeTitle(GITHUB_TEST_TREE, "every-blocker-closed"));
		expect(of("issue", "view")).toHaveLength(1);
		expect(of("issue", "edit")).toHaveLength(1);
	});

	test("resolves a bare short form against the working directory's remote", () => {
		const { runner, of } = starting("ticket-view");
		const result = run([`gh:${recordedIssue(githubRecording("ticket-view"))}`, "--yes"], deps(runner));
		expect(result.code).toBe(0);
		// Resolving the bare form, checking the ticket belongs here, and the claim all take the same value; a
		// second reading is what would let two of them disagree. ADR-0039.
		expect(of("get-url")).toHaveLength(1);
		expect(of("issue", "view")).toHaveLength(1);
	});

	/**
	 * The two writes would otherwise land in different repositories: the claim where the reference names, the
	 * worktree and the session here. `CliDeps.cwd`'s own docstring names that outcome as the one to prevent, and a
	 * pasted URL from another repository is the ordinary way to reach it.
	 */
	test("refuses a ticket from another repository, before anything is read", () => {
		const { runner, of } = starting("ticket-view");
		const result = run(["gh:example/repo#1", "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("example/repo");
		expect(result.stderr).toContain(GITHUB_TEST_TREE.repo);
		// The remedy is to run this elsewhere, not to spell the line differently, so the usage would bury it.
		expect(result.stderr).not.toContain("usage: nextup");
		expect(of("issue", "view")).toEqual([]);
		expect(of("worktree", "add")).toEqual([]);
		expect(of("issue", "edit")).toEqual([]);
	});
});

/**
 * What a failure after the worktree tells the operator, over every combination that changes the answer.
 *
 * The inputs that decide it: which step failed, whether the ticket carried a claim before this run, and whether the
 * operator named it. Gathered here rather than beside the test of whichever path introduced each, so that a change
 * to one message is read against all of them.
 *
 * `--force` is not among the inputs because nothing reads it: a message that guesses at the next invocation's flags
 * cannot be made correct by enumerating more of them, so the session branch predicts nothing for a named ticket.
 *
 * One arm is deliberately absent: a `Claim` whose `by` is null. `readClaim` demands a login string from GitHub's
 * assignees, so this tracker cannot produce one, and the wording handles it for an adapter that later can.
 */
describe("the recovery a failure after the worktree leaves open", () => {
	const TREE = openIssues(GITHUB_TEST_TREE).length;
	const LIMIT = ["--limit", String(TREE)];
	const FAILED_CLAIM = (argv: string[]): CommandResult | null =>
		argv[1] === "issue" && argv[2] === "edit" ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } : null;

	function namedTicket(recording: string): string {
		return `gh:${GITHUB_TEST_TREE.repo}#${recordedIssue(githubRecording(recording))}`;
	}

	// A named ticket that nobody held: the claim state is the ranked path's, so the wording has to be too — the
	// override path is not a reason to report a claim that was never there.
	test("a named unclaimed ticket whose claim failed reads as unclaimed, like a ranked one", () => {
		const { runner } = startSequence(FAILED_CLAIM, "ticket-view");
		const result = run([namedTicket("ticket-view"), "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("the ticket is still unclaimed");
		expect(result.stderr).not.toContain("among its assignees");
	});

	/**
	 * A failure of neither class, after the worktree exists. It is returned untouched so it keeps the stack that is
	 * all it has — and must not pick up a recovery sentence, since nobody has classified what recovers.
	 */
	test("an unclassified failure keeps its stack and gains no recovery sentence", () => {
		const { runner, of } = startSequence((argv) => {
			if (argv[1] === "issue" && argv[2] === "edit") throw new TypeError("undefined is not a function");
			return null;
		}, "ticket-view");
		const result = run([namedTicket("ticket-view"), "--yes"], deps(runner));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("undefined is not a function");
		expect(result.stderr).toContain("    at ");
		expect(result.stderr).not.toContain("running this again");
		expect(result.stderr).not.toContain("would pick a different ticket");
		// Past the worktree, which is what makes this the pass-through path rather than an earlier refusal.
		expect(of("worktree", "add")).toHaveLength(1);
	});

	// Both error branches name the worktree, because it is the leftover a failure is allowed to have and the only
	// thing a re-run continues from. Asserted across the branches rather than inside one, so neither can lose it.
	test("every classified failure names the worktree it left behind", () => {
		const failures: readonly (readonly [string, (argv: string[]) => CommandResult | null])[] = [
			["a claim that would not land", FAILED_CLAIM],
			["a session that would not start", (argv) => (argv[1] === "new-workspace" ? { code: 1, stdout: "", stderr: "no window" } : null)],
		];
		for (const [, over] of failures) {
			for (const argv of [[...LIMIT, "--yes"], [namedTicket("ticket-view"), "--yes"]]) {
				const read = argv[0] === "--limit" ? "ticket-set" : "ticket-view";
				const result = run(argv, deps(startSequence(over, read).runner));
				expect(result.code).toBe(2);
				expect(result.stderr).toContain(`${PRIMARY}/.worktrees/`);
			}
		}
	});
});
