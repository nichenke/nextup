import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./cli";
import { DEGRADED_PREFIX } from "./selection-output";

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
		const result = run([], { cwd: repo });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:1 — Settle the format");
		expect(result.stdout).toContain("unblocks 1");
		expect(result.stderr).toBe("");
	});

	test("emits the selection as JSON on request", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--json"], { cwd: repo });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).pick.ref).toBe("md:1");
	});

	test("reads the effort named on the command line", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		const other = writeEffort(repo, "two", { "05-only.md": "# 05 — Something else\n\nStatus: open\n" });
		const result = run(["--effort", other], { cwd: repo });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("md:5 — Something else");
	});

	test("refuses to guess which of several efforts was meant, and names them", () => {
		const repo = tempRepo();
		chainedEffort(repo, "one");
		chainedEffort(repo, "two");
		const result = run([], { cwd: repo });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--effort");
		expect(result.stderr).toContain("one");
		expect(result.stderr).toContain("two");
	});

	test("says plainly when there is no effort to read", () => {
		const result = run([], { cwd: tempRepo() });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(".scratch");
	});

	test("reports a refused effort as an error rather than an errno", () => {
		const repo = tempRepo();
		const result = run(["--effort", join(repo, "nowhere")], { cwd: repo });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not an effort");
	});

	test("exits non-zero, but not as an error, when there is nothing to recommend", () => {
		const repo = tempRepo();
		writeEffort(repo, "stuck", {
			"01-first.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-second.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run([], { cwd: repo });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
		expect(result.stderr).toBe("");
	});

	test("carries the degraded sentinel into the human rendering", () => {
		const repo = tempRepo();
		writeEffort(repo, "degraded", {
			"01-first.md": "# 01 — Support the legacy format\n\nStatus: wontfix\n",
			"02-second.md": "# 02 — Read a legacy archive\n\nStatus: open\nBlocked by: 01\n",
		});
		const result = run([], { cwd: repo });
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
		expect(run(["--exclude", "ready-for-human"], { cwd: repo }).stdout).toContain("md:2");
	});

	test("keeps only an included label", () => {
		const repo = tempRepo();
		triageEffort(repo);
		expect(run(["--include", "ready-for-human"], { cwd: repo }).stdout).toContain("md:1");
	});

	test("takes both flags more than once", () => {
		const repo = tempRepo();
		triageEffort(repo);
		const result = run(["--exclude", "ready-for-human", "--exclude", "ready-for-agent"], { cwd: repo });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no candidate to recommend");
	});

	test("keeps the wayfinder exclusion under a filter flag that never mentioned wayfinder", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		expect(JSON.parse(run(["--json"], { cwd: repo }).stdout).filter.exclude).toEqual(["wayfinder:*"]);
		expect(JSON.parse(run(["--json", "--include", "ready-for-agent"], { cwd: repo }).stdout).filter).toEqual({
			include: ["ready-for-agent"],
			exclude: ["wayfinder:*"],
		});
		expect(JSON.parse(run(["--json", "--exclude", "needs-info"], { cwd: repo }).stdout).filter).toEqual({
			include: [],
			exclude: ["wayfinder:*", "needs-info"],
		});
	});

	test("refuses a pattern the grammar does not accept", () => {
		const repo = tempRepo();
		chainedEffort(repo);
		const result = run(["--exclude", "way*er"], { cwd: repo });
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

	// `process.exit` tore the process down before an asynchronous pipe write drained, so a reader slower
	// than the writer got a truncated document and an exit status of 0 saying it was fine.
	test("delivers the whole JSON document to a reader slower than itself", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync(["sh", "-c", `bun ${BIN} --json --effort ${effort} | (sleep 1; cat)`]);
		const direct = Bun.spawnSync(["bun", BIN, "--json", "--effort", effort]);

		expect(direct.stdout.length).toBeGreaterThan(65536);
		expect(piped.stdout.toString()).toBe(direct.stdout.toString());
		expect(JSON.parse(piped.stdout.toString()).counts.tickets).toBe(400);
	});

	// The sibling of the case above: a reader that closes early rather than one that reads slowly. An
	// unhandled EPIPE exits 1, which this command defines as "nothing to recommend", so `| head` on a
	// real pick reads as an empty ticket set.
	test("exits on a pick as a pick when the reader closes early", () => {
		const effort = largeEffort(tempRepo());
		const piped = Bun.spawnSync([
			"bash",
			"-c",
			`bun ${BIN} --json --effort ${effort} | head -c 200 > /dev/null; echo \${PIPESTATUS[0]}`,
		]);
		expect(piped.stdout.toString().trim()).toBe("0");
		expect(piped.stderr.toString()).not.toContain("EPIPE");
	});

	test("exits 0 on a pick, 1 with nothing to recommend, and 2 on a bad invocation", () => {
		const repo = tempRepo();
		const effort = chainedEffort(repo);
		expect(Bun.spawnSync(["bun", BIN, "--effort", effort]).exitCode).toBe(0);

		const stuck = writeEffort(repo, "stuck", {
			"01-a.md": "# 01 — Migrate the store\n\nStatus: open\nBlocked by: 02\n",
			"02-b.md": "# 02 — Cut over the reads\n\nStatus: open\nBlocked by: 01\n",
		});
		expect(Bun.spawnSync(["bun", BIN, "--effort", stuck]).exitCode).toBe(1);
		expect(Bun.spawnSync(["bun", BIN, "--rank-by", "size"]).exitCode).toBe(2);
	});
});

describe("the command line itself", () => {
	test("prints usage on request", () => {
		const result = run(["--help"], { cwd: tempRepo() });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--effort");
		expect(result.stdout).toContain("--json");
	});

	test("refuses an unrecognised flag rather than ignoring it", () => {
		const result = run(["--rank-by", "size"], { cwd: tempRepo() });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--rank-by");
	});

	test("refuses a flag whose value is missing", () => {
		const result = run(["--effort"], { cwd: tempRepo() });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--effort");
	});

	test("refuses a bare argument, which no flag takes yet", () => {
		const result = run(["md:1"], { cwd: tempRepo() });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("md:1");
	});
});
