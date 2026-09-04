import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CliDeps, run } from "./cli";
import type { Runner } from "./runner";
import { DEGRADED_PREFIX } from "./selection-output";

/**
 * The whole tool driven with no external binary reachable at all. Markdown asks for no process, and a
 * runner that refuses every command is how that is asserted rather than assumed — every test below
 * runs through it, so a call that started shelling out would fail loudly here first.
 */
const refuseToRun: Runner = (argv) => {
	throw new Error(`nothing may run an external process here: ${argv.join(" ")}`);
};

/**
 * A terminal that answers the gate, and a record of what it was shown. Approving by default keeps the
 * tests below about what they are named for; the gate has its own describe block.
 */
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

function deps(cwd: string, confirm: CliDeps["confirm"] = terminal().confirm): CliDeps {
	return { cwd, runner: refuseToRun, confirm };
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

function writeEffort(repoRoot: string, effort: string, files: Record<string, string>): string {
	const effortRoot = join(repoRoot, ".scratch", effort);
	mkdirSync(join(effortRoot, "issues"), { recursive: true });
	writeFileSync(join(effortRoot, "map.md"), "## Destination\n\nSomewhere.\n");
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(effortRoot, "issues", name), body);
	}
	return effortRoot;
}

/** Two open tickets, the second waiting on the first, so the answer is never a coin toss. */
function chainedEffort(repoRoot: string, effort = "an-effort"): string {
	return writeEffort(repoRoot, effort, {
		"01-first.md": "# 01 — Settle the format\n\nStatus: open\n",
		"02-second.md": "# 02 — Write the reader\n\nStatus: open\nBlocked by: 01\n",
	});
}

describe("run", () => {
	test("names the ticket to start next, and why, from the one effort it finds", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:1 — Settle the format");
		expect(result.stdout).toContain("unblocks 1");
		expect(result.stderr).toBe("");
	});

	test("emits the selection as JSON on request", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--json"], deps(repo));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).pick.ref).toBe("md:1");
	});

	test("reads the effort named on the command line", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		const other = writeEffort(repo, "two", { "05-only.md": "# 05 — Something else\n\nStatus: open\n" });
		const result = run(["--yes", "--effort", other], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:5 — Something else");
	});

	test("refuses to guess which of several efforts was meant, and names them", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		chainedEffort(repo, "two");
		const result = run([], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--effort");
		expect(result.stderr).toContain("one");
		expect(result.stderr).toContain("two");
	});

	test("says plainly when there is no effort to read", () => {
		const result = run([], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(".scratch");
	});

	test("reports a refused effort as an error rather than an errno", () => {
		const repo = tempRepo();
		const result = run(["--effort", join(repo, "nowhere")], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not an effort");
	});

	test("exits non-zero, but not as an error, when there is nothing to recommend", () => {
		const repo = tempRepo();
		writeEffort(repo, "stuck", {
			"01-first.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-second.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run([], deps(repo));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
		expect(result.stderr).toBe("");
	});

	// A ticket file that cannot be read vanishes from the effort. Without a signal the pick reads as
	// confident, and the ticket that would have won may be the one that vanished.
	test("degrades rather than presenting an effort it could not fully read as complete", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "partial", { "09-chore.md": "# 09 — Low priority chore\n\nStatus: open\n" });
		symlinkSync("/nonexistent/gone.md", join(effort, "issues", "01-critical.md"));

		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").some((line) => line.startsWith(DEGRADED_PREFIX))).toBe(true);
		expect(JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout).degraded).toEqual(["truncated"]);
	});

	test("reads an effort with only real ticket files as complete", () => {
		const repo = tempRepo();
		writeEffort(repo, "whole", {
			"01-a.md": "# 01 — First\n\nStatus: open\n",
			"README.md": "Not a ticket, and not a gap.\n",
		});
		expect(JSON.parse(run(["--json"], deps(repo)).stdout).degraded).toEqual([]);
	});

	test("carries the degraded sentinel into the human rendering", () => {
		const repo = tempRepo();
		writeEffort(repo, "degraded", {
			"01-first.md": "# 01 — Support the legacy format\n\nStatus: wontfix\n",
			"02-second.md": "# 02 — Read a legacy archive\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run(["--yes"], deps(repo));
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").some((line) => line.startsWith(DEGRADED_PREFIX))).toBe(true);
	});
});

describe("the label filter flags", () => {
	function triageEffort(repoRoot: string): void {
		writeEffort(repoRoot, "triage", {
			"01-first.md": "# 01 — Needs a person\n\nStatus: ready-for-human\n",
			"02-second.md": "# 02 — Ready to build\n\nStatus: ready-for-agent\n",
		});
	}

	test("drops an excluded label", () => {
		const repo = tempRepo();
		triageEffort(repo);
		expect(run(["--exclude", "ready-for-human"], deps(repo)).stdout).toContain("md:2");
	});

	test("keeps only an included label", () => {
		const repo = tempRepo();
		triageEffort(repo);
		expect(run(["--include", "ready-for-human"], deps(repo)).stdout).toContain("md:1");
	});

	test("takes both flags more than once", () => {
		const repo = tempRepo();
		triageEffort(repo);
		const result = run(["--exclude", "ready-for-human", "--exclude", "ready-for-agent"], deps(repo));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
	});

	test("keeps the wayfinder exclusion under a filter flag that never mentioned wayfinder", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		expect(JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout).filter.exclude).toEqual(["wayfinder:*"]);
		const included = run(["--json", "--print-command", "--include", "ready-for-agent"], deps(repo));
		expect(JSON.parse(included.stdout).filter).toEqual({ include: ["ready-for-agent"], exclude: ["wayfinder:*"] });
		const excluded = run(["--json", "--print-command", "--exclude", "needs-info"], deps(repo));
		expect(JSON.parse(excluded.stdout).filter).toEqual({ include: [], exclude: ["wayfinder:*", "needs-info"] });
	});

	test("refuses a pattern the grammar does not accept", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--exclude", "way*er"], deps(repo));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("way*er");
	});
});

/**
 * `run` returns its output as a string, so nothing above this reaches the process streams that
 * `bin/nextup.ts` writes to. These drive the real executable.
 */
describe("bin/nextup.ts", () => {
	const BIN = join(dirname(import.meta.dir), "bin", "nextup.ts");

	/** Enough tickets that the JSON exceeds a 64KB pipe buffer and a writer can outrun its reader. */
	function largeEffort(repoRoot: string): string {
		const files: Record<string, string> = {};
		for (let number = 1; number <= 400; number++) {
			files[`${number}-t.md`] = `# ${number} — Ticket number ${number}, titled at length to pad the document\n\nStatus: open\n`;
		}
		return writeEffort(repoRoot, "large", files);
	}

	test("delivers the whole JSON document to a reader slower than itself", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync(["sh", "-c", `bun ${BIN} --json --print-command --effort ${effort} | (sleep 1; cat)`]);
		const direct = Bun.spawnSync(["bun", BIN, "--json", "--print-command", "--effort", effort]);

		expect(direct.stdout.length).toBeGreaterThan(65536);
		expect(piped.stdout.toString()).toBe(direct.stdout.toString());
		expect(JSON.parse(piped.stdout.toString()).counts.tickets).toBe(400);
	});

	test("exits on a pick as a pick when the reader closes early", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync([
			"bash",
			"-c",
			`bun ${BIN} --json --print-command --effort ${effort} | head -c 200 > /dev/null; echo \${PIPESTATUS[0]}`,
		]);
		expect(piped.stdout.toString().trim()).toBe("0");
		expect(piped.stderr.toString()).not.toContain("EPIPE");
	});

	test("exits 0 on a pick, 1 with nothing to recommend, and 2 on a bad invocation", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", effort]).exitCode).toBe(0);

		const stuck = writeEffort(repo, "stuck", {
			"01-a.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-b.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", stuck]).exitCode).toBe(1);
		expect(Bun.spawnSync(["bun", BIN, "--rank-by", "size"]).exitCode).toBe(2);
	});

	// Bun.spawnSync gives the child no controlling terminal, which is the unattended case itself: the
	// gate has nobody to ask and the run is refused rather than answered for.
	test("refuses to claim with no terminal to ask on, and claims under --yes", () => {
		const effort = chainedEffort(tempRepo());
		expect(Bun.spawnSync(["bun", BIN, "--effort", effort]).exitCode).toBe(2);
		expect(Bun.spawnSync(["bun", BIN, "--yes", "--effort", effort]).exitCode).toBe(0);
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], deps(tempRepo()));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--effort");
		expect(result.stdout).toContain("--json");
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--effort"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--effort");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["md:1"], deps(tempRepo()));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("md:1");
	});
});

describe("claiming the pick", () => {
	function ticketPath(effortRoot: string, name: string): string {
		return join(effortRoot, "issues", name);
	}

	test("claims the winner in the tracker, and says what it would run on it", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const result = run(["--yes"], deps(repo));

		expect(result.code).toBe(0);
		expect(readFileSync(ticketPath(effort, "01-first.md"), "utf8")).toContain("Status: claimed");
		expect(result.stdout).toContain("claimed md:1");
		expect(result.stdout).toContain("would run: claude '/implement md:1'");
	});

	test("hands the next run a different ticket, because the first one is claimed", () => {
		const repo = tempRepo();
		writeEffort(repo, "two-ready", {
			"01-first.md": "# 01 — Settle the format\n\nStatus: open\n",
			"02-second.md": "# 02 — Write the reader\n\nStatus: open\n",
		});

		expect(run([], deps(repo)).stdout).toContain("claimed md:1");
		expect(run([], deps(repo)).stdout).toContain("claimed md:2");
		expect(run([], deps(repo)).code).toBe(1);
	});

	// A ticket somebody else took is worth coming back for; a ticket file this tool cannot write is
	// not, and lands on the same status as a bad invocation.
	test("separates a pick that was unavailable from a ticket set that will not take a claim", () => {
		const unavailable = tempRepo();
		const effort = chainedEffort(unavailable);
		chmodSync(ticketPath(effort, "01-first.md"), 0o444);
		const refused = run([], deps(unavailable));
		expect(refused.code).toBe(3);
		expect(refused.stderr).toContain("01-first.md");

		const unwritable = tempRepo();
		writeEffort(unwritable, "an-effort", { "01-first.md": "# 01 — A\n\n**Status: op**en\n" });
		expect(run([], deps(unwritable)).code).toBe(2);
	});

	test("carries the claim and the command in the JSON, so a caller needs no second invocation", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const document = JSON.parse(run(["--json"], deps(repo)).stdout);

		expect(document.claimed).toBe(true);
		expect(document.command).toEqual(["claude", "/implement md:1"]);
	});
});

describe("--print-command", () => {
	test("emits the launch command and claims nothing", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const result = run(["--print-command"], deps(repo));

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("claude '/implement md:1'\n");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("keeps why the ticket won off the stream carrying the command", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--print-command"], deps(repo));

		expect(result.stderr).toContain("md:1 — Settle the format");
		expect(result.stdout).not.toContain("Settle the format");
	});

	test("says so on stderr, and prints no command, when there is nothing to start", () => {
		const repo = tempRepo();
		writeEffort(repo, "stuck", {
			"01-first.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-second.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run(["--print-command"], deps(repo));

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no candidate to recommend");
	});

	test("reports the selection as JSON without claiming, which is the whole read-only answer", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const document = JSON.parse(run(["--json", "--print-command"], deps(repo)).stdout);

		expect(document.claimed).toBe(false);
		expect(document.command).toEqual(["claude", "/implement md:1"]);
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});
});

describe("the confirmation gate", () => {
	test("shows the pick and what approving it runs, then claims only once approved", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const asked = terminal();

		const result = run([], deps(repo, asked.confirm));

		expect(asked.questions).toHaveLength(1);
		expect(asked.questions[0]).toContain("md:1 — Settle the format");
		expect(asked.questions[0]).toContain("would run: claude '/implement md:1'");
		expect(asked.questions[0]).toContain("[y/N]");
		expect(result.code).toBe(0);
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).toContain("Status: claimed");
	});

	test("claims nothing when the pick is declined, and says so", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);

		const result = run([], deps(repo, terminal(false).confirm));

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("md:1 not claimed");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("a declined pick is a quiet day to a caller reading JSON, not a claim", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const document = JSON.parse(run(["--json"], deps(repo, terminal(false).confirm)).stdout);

		expect(document.claimed).toBe(false);
		expect(document.command).toBeNull();
	});

	test("--yes claims without asking, which is what an unattended run needs", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		const asked = terminal();

		const result = run(["--yes"], deps(repo, asked.confirm));

		expect(asked.questions).toEqual([]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("claimed md:1");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).toContain("Status: claimed");
	});

	// Answering on the user's behalf is the one thing a gate must not do, in either direction: a silent
	// yes claims unasked, and a silent no looks exactly like an empty backlog.
	test("refuses with nothing to ask on, naming the flag that means yes", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);

		const result = run([], deps(repo, null));

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--yes");
		expect(readFileSync(join(effort, "issues", "01-first.md"), "utf8")).not.toContain("claimed");
	});

	test("never asks about a run that claims nothing", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const asked = terminal();

		expect(run(["--print-command"], deps(repo, asked.confirm)).code).toBe(0);
		expect(run(["--print-command"], deps(repo, null)).code).toBe(0);
		expect(asked.questions).toEqual([]);
	});
});
