import { withoutBlockingField } from "./command-builders";
import { collapseFailure } from "./failure-class";
import { readGitHubTicket, readGitHubTicketSet } from "./github-adapter";
import type { TrackerObservation, ObservedBlocker, ReconstructionTracker } from "./reconstruction";
import type { Runner } from "./runner";
import { type GitHubTicketRef, TicketRefError, githubTicketRef } from "./ticket-ref";
import type { TicketSetRead } from "./ticket-set-read";

export class GitHubReconstructionError extends Error {}

/**
 * A page size high enough that a repository this tool is useful on needs one page, paired with `--paginate` so
 * that one which does not is read whole rather than silently to its first page.
 */
const PAGE = 100;

/**
 * The open tickets, asked of the REST collection rather than of `gh issue list`.
 *
 * `--slurp` because `--paginate` alone concatenates one JSON array per page, which is not a document; slurped, the
 * response is one array of pages. `--jq` cannot be combined with it, so the narrowing happens here in TypeScript.
 */
function openIssuesRequest(repo: string): readonly string[] {
	return ["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues?state=open&per_page=${PAGE}`];
}

/**
 * One ticket's blockers, asked of the per-issue dependency endpoint — one of the two surfaces
 * `docs/agents/issue-tracker.md` measures as authoritative on the first read.
 */
function blockedByRequest(repo: string, key: string): readonly string[] {
	return ["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues/${key}/dependencies/blocked_by?per_page=${PAGE}`];
}

export interface GitHubReconstructionInput {
	readonly runner: Runner;
	readonly repo: string;
}

/**
 * GitHub's reconstruction: the adapter's own read, the same read with no blocking field, and an expected answer
 * assembled from a surface that shares no parsing code with either. ADR-0033's table is which fact each side
 * reads from where, and why sharing any of it would hide the defect this is for.
 */
export function githubReconstructionTracker(input: GitHubReconstructionInput): ReconstructionTracker {
	return {
		name: `github ${input.repo}`,
		observe: () => observe(input),
		read: (limit) => readGitHubTicketSet({ runner: input.runner, limit, repo: input.repo }),
		readBlind: (limit) => readBlind(input, limit),
		readNamed: (ref) => readGitHubTicket({ runner: input.runner, ref }),
	};
}

/**
 * The same read the adapter makes, answered without a blocking field.
 *
 * Done by narrowing the projection in the argv on its way to the tracker, rather than by giving the adapter a
 * parameter for it: what is under test is the adapter's own parsing of a response with the field absent, so the
 * read has to be the one it builds for itself.
 */
function readBlind(input: GitHubReconstructionInput, limit: number): TicketSetRead {
	const blinded: Runner = (argv) => input.runner([...withoutBlockingField(argv)]);
	return readGitHubTicketSet({ runner: blinded, limit, repo: input.repo });
}

function observe(input: GitHubReconstructionInput): readonly TrackerObservation[] {
	const rows = request(input.runner, openIssuesRequest(input.repo), `the open tickets of ${input.repo}`);
	return rows
		// A pull request is an issue on this endpoint and is not one on `gh issue list`, so it is dropped here to
		// leave the two sides reading the same set. As a *blocker* it still counts, and `blockersOf` keeps it.
		.filter((row) => row.pull_request === undefined || row.pull_request === null)
		.map((row, index) => observation(row, input, `${input.repo} open issue ${index}`));
}

function observation(row: Record<string, unknown>, input: GitHubReconstructionInput, where: string): TrackerObservation {
	const key = String(number(row.number, `${where} number`));
	return {
		ref: githubRef(repoOf(text(row.repository_url, `${where} repository_url`), `${where} repository_url`), key, `${where} repository_url`),
		claimed: list(row.assignees, `${where} assignees`).length > 0,
		labels: list(row.labels, `${where} labels`).map((label, at) => text(object(label, `${where} labels[${at}]`).name, `${where} labels[${at}].name`)),
		blockers: blockersOf(input, key, `${where} blockers`),
	};
}

/**
 * One ticket's blockers, from the per-issue dependency endpoint.
 *
 * Its rows carry a nested `repository` object, not the `repository_url` an issue-list row identifies its
 * repository with — for a blocker in this repository as well as one outside it. Reading `repository_url` here is
 * the plausible wrong move, and a review took the two endpoints for one shape and reported this as broken: a live
 * run parsed fifteen blockers this way, eight of them same-repo.
 */
function blockersOf(input: GitHubReconstructionInput, key: string, where: string): readonly ObservedBlocker[] {
	return request(input.runner, blockedByRequest(input.repo, key), where).map((row, index) => {
		const at = `${where}[${index}]`;
		const repository = object(row.repository, `${at} repository`);
		return {
			ref: githubRef(text(repository.full_name, `${at} repository.full_name`), String(number(row.number, `${at} number`)), `${at} repository.full_name`),
			open: isOpen(row.state, `${at} state`),
		};
	});
}

/**
 * One slurped request's rows, with the pages flattened.
 *
 * @throws GitHubReconstructionError on any failure at all, including a connectivity one — `TrackerObservation` has why an
 * expected answer may not degrade.
 */
function request(runner: Runner, argv: readonly string[], where: string): readonly Record<string, unknown>[] {
	const result = runner([...argv]);
	if (result.code !== 0) {
		throw new GitHubReconstructionError(`reading ${where} independently failed with exit ${result.code}: ${collapseFailure(result.stderr) || "no stderr"}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(result.stdout);
	} catch (cause) {
		throw new GitHubReconstructionError(`reading ${where} independently returned no JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (!Array.isArray(raw)) throw new GitHubReconstructionError(`reading ${where} independently returned ${typeof raw} where pages were asked for`);
	return raw.flatMap((page, index) => {
		if (!Array.isArray(page)) throw new GitHubReconstructionError(`${where} page ${index} is not a list`);
		return page.map((row, at) => object(row, `${where} page ${index} row ${at}`));
	});
}

/**
 * The owner and repository from an API collection address, taken as the two segments after `/repos/`.
 *
 * Deliberately a different field, read by different code, than the adapter's `addressRepo`. Reusing that parser
 * is the tempting simplification and it defeats the check: the two sides would agree about a repository by
 * construction rather than by both reading it right.
 */
function repoOf(address: string, where: string): string {
	const repo = /\/repos\/([^/\s?#]+\/[^/\s?#]+)$/.exec(address)?.[1];
	if (repo === undefined) throw new GitHubReconstructionError(`${where} names no owner and repository: ${address}`);
	return repo;
}

/**
 * One reference built from a row this side read independently, reported as a bad response the way every other
 * reader here does — `github-adapter.ts` has the same helper for the same reason.
 *
 * @throws GitHubReconstructionError when the row's repository path or issue number is not one a reference can hold.
 */
function githubRef(repo: string, key: string, where: string): GitHubTicketRef {
	try {
		return githubTicketRef(repo, key);
	} catch (cause) {
		if (cause instanceof TicketRefError) throw new GitHubReconstructionError(`${where}: ${cause.message}`);
		throw cause;
	}
}

function object(raw: unknown, where: string): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new GitHubReconstructionError(`${where} is not an object`);
	return raw as Record<string, unknown>;
}

function list(raw: unknown, where: string): readonly unknown[] {
	if (!Array.isArray(raw)) throw new GitHubReconstructionError(`${where} is not a list`);
	return raw;
}

function text(raw: unknown, where: string): string {
	if (typeof raw !== "string" || raw === "") throw new GitHubReconstructionError(`${where} is not a non-empty string`);
	return raw;
}

function number(raw: unknown, where: string): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new GitHubReconstructionError(`${where} is not a whole number`);
	return raw;
}

/**
 * Whether one blocker is open. This endpoint spells it in lower case where `gh issue list --json` spells it in
 * upper, so case is folded rather than picked: neither spelling is what this depends on.
 */
function isOpen(raw: unknown, where: string): boolean {
	const value = text(raw, where).toUpperCase();
	if (value === "OPEN") return true;
	if (value === "CLOSED") return false;
	throw new GitHubReconstructionError(`${where} is ${value}, which is neither open nor closed`);
}
