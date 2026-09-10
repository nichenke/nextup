#!/usr/bin/env bun
/**
 * Captures the GitHub replay corpus. Local and manual, never CI: it needs a credentialed `gh`. ADR-0019 is the
 * provenance rule and `docs/agents/test-tree.md` is how and when to run this.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TICKET_FIELDS, githubClaimCommand, githubIssueListCommand } from "../src/command-builders";
import { GITHUB_PLACEHOLDER_HOST, redactRecordingIdentifiers } from "../src/recording-identifiers";
import { type Recording, recordingsDir } from "../src/recording";
import { defaultRunner } from "../src/runner";
import { GITHUB_TEST_TREE, openIssues } from "../src/test-tree";
import { issueNumber, requirePrivate } from "../src/test-tree-provision";

/** One more than the tree's open issues, so every row a read returns arrives and the extra one does not. */
const WHOLE_TREE_ROWS = openIssues(GITHUB_TEST_TREE).length + 1;

/** Under the tree's size, so the over-fetched row arrives and the read reports itself truncated. */
const TRUNCATING_ROWS = 4;

// Neither exists, which is why asking about them reads nobody's project. The host is joined from parts to
// pass the identifier guard, per CLAUDE.md.
const UNRESOLVABLE = `${["nextup-outage", "invalid"].join(".")}/nichenke/unreachable`;
const ABSENT_REPO = "nichenke/nextup-nope-does-not-exist";

/**
 * Far above anything the tree will hold, for the failing write. A number inside the tree's own repository
 * rather than a second absent repository: a write aimed at a name that does not exist yet is a write that
 * lands the moment somebody creates it, and `succeeds: false` only refuses *after* the call.
 */
const ABSENT_ISSUE = "999999";

interface Capture {
	readonly name: string;
	readonly description: string;
	readonly argv: readonly string[];
	/**
	 * Whether this exchange is expected to succeed. Checked after the call and before the file is written, so a
	 * capture that stops failing refuses rather than storing whatever answered in its place — which for
	 * `read-defect` would be a stranger's issues, were the repository it names ever created.
	 *
	 * For a failing *write* the refusal comes after the tracker has already been mutated, so it protects the
	 * corpus and not the tree; `ABSENT_ISSUE` is chosen with that in mind.
	 */
	readonly succeeds: boolean;
}

/**
 * Every exchange to store, in order. The reads come before the writes on purpose: the claim below assigns the
 * tree's write target, and a read captured after it would store that assignment as the tree's resting shape —
 * which `src/test-tree.ts` specs as unassigned and `github-adapter.test.ts` asserts.
 */
function captures(writeTarget: string): readonly Capture[] {
	return [
		{
			name: "ticket-set",
			description: "The whole tree in one read, asking for one row more than it holds, so nothing is truncated.",
			argv: githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: WHOLE_TREE_ROWS }),
			succeeds: true,
		},
		{
			name: "ticket-set-truncated",
			description: "The same read capped below the tree's size, so the over-fetched row arrives and says so.",
			argv: githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: TRUNCATING_ROWS }),
			succeeds: true,
		},
		{
			name: "ticket-set-without-blockers",
			description:
				"The same read with the blocking field left out of the projection, so every row carries no blockedBy key at all — the shape a read of an unavailable dependency surface has to be told apart from an empty one.",
			argv: withoutBlockedBy(githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: WHOLE_TREE_ROWS })),
			succeeds: true,
		},
		{
			name: "read-outage",
			description: "A host that cannot resolve, for the connectivity wording an outage has to be recognised by.",
			argv: githubIssueListCommand({ repo: UNRESOLVABLE, rows: WHOLE_TREE_ROWS }),
			succeeds: false,
		},
		{
			name: "read-defect",
			description: "A repository that does not exist, for the wording of a request that is itself wrong.",
			argv: githubIssueListCommand({ repo: ABSENT_REPO, rows: WHOLE_TREE_ROWS }),
			succeeds: false,
		},
		{
			name: "claim",
			description:
				"The claim landing on the tree's write target, which is the whole write path: one call, whose exit status is the entire verdict.",
			argv: githubClaimCommand({ repo: GITHUB_TEST_TREE.repo, key: writeTarget }),
			succeeds: true,
		},
		{
			name: "claim-defect",
			description: "A claim naming an issue the tree does not have, for the wording of a write that is itself wrong.",
			argv: githubClaimCommand({ repo: GITHUB_TEST_TREE.repo, key: ABSENT_ISSUE }),
			succeeds: false,
		},
		{
			name: "claim-outage",
			description: "A claim against a host that cannot resolve, for the connectivity wording a failed write is read as an outage by.",
			argv: githubClaimCommand({ repo: UNRESOLVABLE, key: writeTarget }),
			succeeds: false,
		},
	];
}

/** The projection minus the blocking field, which no adapter asks for and only a capture needs. */
function withoutBlockedBy(argv: readonly string[]): readonly string[] {
	const projection = GITHUB_TICKET_FIELDS.join(",");
	const kept = GITHUB_TICKET_FIELDS.filter((field) => field !== "blockedBy").join(",");
	// Refused rather than returned unchanged: a capture of the full projection under this name is a recording
	// of the opposite shape, and the test reading it would assert nothing while passing.
	if (!argv.includes(projection)) throw new Error("the issue-list argv no longer spells its projection as one word");
	return argv.map((word) => (word === projection ? kept : word));
}

function cliVersion(): string {
	const result = defaultRunner(["gh", "--version"]);
	if (result.code !== 0) throw new Error(`gh --version failed: ${result.stderr.trim()}`);
	return result.stdout.split("\n")[0]?.trim() ?? "";
}

function capture(one: Capture, cli: string): Recording {
	const result = defaultRunner([...one.argv]);
	if (one.succeeds !== (result.code === 0)) {
		throw new Error(
			`${one.name} was expected to ${one.succeeds ? "succeed" : "fail"} and exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
		);
	}
	return {
		description: one.description,
		cli,
		argv: one.argv,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * Puts the tree's write target back to unassigned, which is the state `src/test-tree.ts` specs it in and every
 * read capture above recorded it in.
 *
 * Reported rather than thrown, because this runs on the way out of a failed capture too and must not replace the
 * error that got us here — but it sets a failing exit status, because a run that exits 0 having stranded the
 * claim gets believed. `bun run provision:test-tree` is the recovery.
 *
 * Unconditional, because `--remove-assignee @me` against an issue nobody holds exits 0 — measured on gh
 * 2.100.0 — so there is no state to check first and get wrong.
 */
function release(writeTarget: string): void {
	// `--` for the reason ADR-0030 gives the claim: the issue is a positional word wherever it is spelled.
	const argv = ["gh", "issue", "edit", "--repo", GITHUB_TEST_TREE.repo, "--remove-assignee", "@me", "--", writeTarget];
	const result = defaultRunner(argv);
	if (result.code !== 0) {
		process.exitCode = 1;
		process.stderr.write(`could not release ${writeTarget}, so run provision:test-tree: ${result.stderr.trim()}\n`);
		return;
	}
	// Exit 0 is not evidence the issue is now unassigned: `--remove-assignee @me` also exits 0 against an issue
	// somebody *else* holds, so a sibling session's claim, or a claim made under another account, survives a
	// release that reported success. Asked rather than assumed, by the same check that guards the start of a run.
	try {
		issueNumber(GITHUB_TEST_TREE, "write-target", defaultRunner);
	} catch (cause) {
		process.exitCode = 1;
		process.stderr.write(`${writeTarget} is not back to its spec'd state, so run provision:test-tree: ${message(cause)}\n`);
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

requirePrivate(GITHUB_TEST_TREE, defaultRunner);

const cli = cliVersion();
// Also the tree's own check: this lookup lists every issue and refuses one the spec does not describe, so a
// stray hand-filed issue stops the run here rather than being stored as a row in `ticket-set.json` — which the
// read captures ask for by repository and cannot filter out. Keep the strict lister rather than narrowing it.
const writeTarget = String(issueNumber(GITHUB_TEST_TREE, "write-target", defaultRunner));
const directory = recordingsDir("github");
mkdirSync(directory, { recursive: true });

try {
	for (const one of captures(writeTarget)) {
		const recording = capture(one, cli);
		const path = join(directory, `${one.name}.json`);
		// Redacted as one serialized blob rather than field by field: `redactRecordingIdentifiers` steps over JSON
		// escapes on purpose, and running it over the finished text is what ADR-0024 measured.
		writeFileSync(path, redactRecordingIdentifiers(`${JSON.stringify(recording, null, "\t")}\n`, GITHUB_PLACEHOLDER_HOST));
		process.stdout.write(`${one.name}: exit ${recording.code}, ${recording.stdout.length} bytes of stdout\n`);
	}
} finally {
	release(writeTarget);
}
