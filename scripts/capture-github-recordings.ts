#!/usr/bin/env bun
/**
 * Captures the GitHub replay corpus. Local and manual, never CI: it needs a credentialed `gh`. ADR-0019 is the
 * provenance rule and `docs/agents/test-tree.md` is how and when to run this.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TICKET_FIELDS, githubIssueListCommand } from "../src/command-builders";
import { GITHUB_PLACEHOLDER_HOST, redactRecordingIdentifiers } from "../src/recording-identifiers";
import { type Recording, recordingsDir } from "../src/recording";
import { defaultRunner } from "../src/runner";
import { GITHUB_TEST_TREE } from "../src/test-tree";
import { requirePrivate } from "../src/test-tree-provision";

/** One more than the tree holds, so the whole tree arrives and the over-fetched row does not. */
const WHOLE_TREE_ROWS = GITHUB_TEST_TREE.issues.length + 1;

/** Under the tree's size, so the over-fetched row arrives and the read reports itself truncated. */
const TRUNCATING_ROWS = 4;

// Neither exists, which is why asking about them reads nobody's project. The host is joined from parts to
// pass the identifier guard, per CLAUDE.md.
const UNRESOLVABLE = `${["nextup-outage", "invalid"].join(".")}/nichenke/unreachable`;
const ABSENT_REPO = "nichenke/nextup-nope-does-not-exist";

interface Capture {
	readonly name: string;
	readonly description: string;
	readonly argv: readonly string[];
}

const CAPTURES: readonly Capture[] = [
	{
		name: "ticket-set",
		description: "The whole tree in one read, asking for one row more than it holds, so nothing is truncated.",
		argv: githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: WHOLE_TREE_ROWS }),
	},
	{
		name: "ticket-set-truncated",
		description: "The same read capped below the tree's size, so the over-fetched row arrives and says so.",
		argv: githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: TRUNCATING_ROWS }),
	},
	{
		name: "ticket-set-without-blockers",
		description:
			"The same read with the blocking field left out of the projection, so every row carries no blockedBy key at all — the shape a read of an unavailable dependency surface has to be told apart from an empty one.",
		argv: withoutBlockedBy(githubIssueListCommand({ repo: GITHUB_TEST_TREE.repo, rows: WHOLE_TREE_ROWS })),
	},
	{
		name: "read-outage",
		description: "A host that cannot resolve, for the connectivity wording an outage has to be recognised by.",
		argv: githubIssueListCommand({ repo: UNRESOLVABLE, rows: WHOLE_TREE_ROWS }),
	},
	{
		name: "read-defect",
		description: "A repository that does not exist, for the wording of a request that is itself wrong.",
		argv: githubIssueListCommand({ repo: ABSENT_REPO, rows: WHOLE_TREE_ROWS }),
	},
];

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
	return {
		description: one.description,
		cli,
		argv: one.argv,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

requirePrivate(GITHUB_TEST_TREE, defaultRunner);

const cli = cliVersion();
const directory = recordingsDir("github");
mkdirSync(directory, { recursive: true });

for (const one of CAPTURES) {
	const recording = capture(one, cli);
	const path = join(directory, `${one.name}.json`);
	// Redacted as one serialized blob rather than field by field: `redactRecordingIdentifiers` steps over JSON
	// escapes on purpose, and running it over the finished text is what ADR-0024 measured.
	writeFileSync(path, redactRecordingIdentifiers(`${JSON.stringify(recording, null, "\t")}\n`, GITHUB_PLACEHOLDER_HOST));
	process.stdout.write(`${one.name}: exit ${recording.code}, ${recording.stdout.length} bytes of stdout\n`);
}
