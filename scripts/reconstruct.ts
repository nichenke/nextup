#!/usr/bin/env bun
/**
 * Reads a real repository's ticket set through the adapter and checks the answer against the tracker's own
 * ground truth. Local and manual, never CI: it needs a credentialed `gh` and a request per open issue.
 * `docs/agents/reconstruction.md` is how to run it and what each verdict means.
 *
 * It writes nothing anywhere, which `docs/agents/reconstruction.md` has the reasons for.
 */
import { resolveOriginRemote } from "../src/git-remote";
import { GitHubAdapterError } from "../src/github-adapter";
import { GitHubReconstructionError, githubReconstructionTracker } from "../src/github-reconstruction";
import { DEFAULT_LABEL_FILTER, compileLabelFilter } from "../src/label-filter";
import { type CheckResult, type ReconstructionReport, ReconstructionError, checkReconstructionTracker, heldEverywhere } from "../src/reconstruction";
import { NotAReadError, readOnlyRunner } from "../src/read-only-runner";
import { defaultRunner } from "../src/runner";
import { GITHUB_HOST, TicketRefError, formatTicketRef, isGitHubHost, isValidRepoPath } from "../src/ticket-ref";

const USAGE = `reconstruct — reads a real repository through the adapter and checks it against the tracker

usage: bun run check:live [--repo <owner/name>]

  --repo <owner/name>  the repository to read; the working directory's origin by default

Exit status: 0 every check held, 1 a check failed or the repository never exercised it, 2 the run could not
be made at all.
`;

function repoFromArgv(argv: readonly string[]): string | null {
	if (argv.length === 0) return null;
	if (argv.length !== 2 || argv[0] !== "--repo") throw new ReconstructionError(`${argv.join(" ")} is not an invocation this takes`);
	const repo = argv[1]!;
	if (!isValidRepoPath("github", repo)) throw new ReconstructionError(`${repo} is not a GitHub owner and repository`);
	return repo;
}

/**
 * The repository to read. Resolved here rather than left to the adapter, because the independent query needs the
 * name in its own endpoint path — and both sides have to be asking about the same repository for a disagreement
 * between them to mean anything.
 */
function resolveRepo(named: string | null): string {
	if (named !== null) return named;
	const origin = resolveOriginRemote(readOnly);
	if (origin === null) throw new ReconstructionError("no repository was named, and the working directory's git remote could not be resolved");
	if (!isGitHubHost(origin.host)) {
		throw new ReconstructionError(`the origin remote points at ${origin.host}, and this check reads ${GITHUB_HOST} only`);
	}
	return origin.repo;
}

const COLUMN = 12;

/** One check as its verdict line, with each of its detail lines indented under it. */
function lines(check: CheckResult): readonly string[] {
	return [`  ${check.verdict.padEnd(COLUMN)}${check.name}`, ...check.detail.map((detail) => `${" ".repeat(COLUMN + 4)}${detail}`)];
}

function render(report: ReconstructionReport): string {
	const tally = (verdict: CheckResult["verdict"]) => report.checks.filter((check) => check.verdict === verdict).length;
	const frontier = report.frontier.length === 0 ? "nothing" : report.frontier.map(formatTicketRef).join(", ");
	return [
		`${report.tracker}`,
		"",
		...report.checks.flatMap(lines),
		"",
		`frontier: ${frontier}`,
		`${tally("held")} held, ${tally("failed")} failed, ${tally("unexercised")} unexercised`,
		"",
	].join("\n");
}

const readOnly = readOnlyRunner(defaultRunner);

try {
	const repo = resolveRepo(repoFromArgv(process.argv.slice(2)));
	const report = checkReconstructionTracker(githubReconstructionTracker({ runner: readOnly, repo }), compileLabelFilter(DEFAULT_LABEL_FILTER));
	process.stdout.write(render(report));
	process.exitCode = heldEverywhere(report) ? 0 : 1;
} catch (cause) {
	process.exitCode = 2;
	if (cause instanceof NotAReadError) {
		process.stderr.write(`the check tried to issue a write, which is a defect in the check: ${cause.message}\n`);
	} else if (
		cause instanceof ReconstructionError ||
		cause instanceof GitHubReconstructionError ||
		cause instanceof GitHubAdapterError ||
		cause instanceof TicketRefError
	) {
		process.stderr.write(`${cause.message}\n${cause instanceof ReconstructionError ? `\n${USAGE}` : ""}`);
	} else {
		// Unclassified, so it keeps its stack: nobody has decided what it is, and whoever reads it needs everything.
		process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
	}
}
