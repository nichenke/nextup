import { withoutBlockingField } from "./command-builders";
import { collapseFailure } from "./failure-class";
import { readGitHubTicketSet } from "./github-adapter";
import type { LiveObservation, LiveObservedBlocker, LiveTracker } from "./live-invariants";
import type { Runner } from "./runner";
import type { TicketSetRead } from "./ticket-set-read";

export class GitHubLiveError extends Error {}

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

export interface GitHubLiveInput {
	readonly runner: Runner;
	readonly repo: string;
}

/**
 * GitHub's live check: the adapter's own read, the same read with no blocking field, and an expected answer
 * assembled from a surface that shares no parsing code with either. ADR-0033's table is which fact each side
 * reads from where, and why sharing any of it would hide the defect this is for.
 */
export function githubLiveTracker(input: GitHubLiveInput): LiveTracker {
	return {
		name: `github ${input.repo}`,
		observe: () => observe(input),
		read: (limit) => readGitHubTicketSet({ runner: input.runner, limit, repo: input.repo }),
		readBlind: (limit) => readBlind(input, limit),
	};
}

/**
 * The same read the adapter makes, answered without a blocking field.
 *
 * Done by narrowing the projection in the argv on its way to the tracker, rather than by giving the adapter a
 * parameter for it: what is under test is the adapter's own parsing of a response with the field absent, so the
 * read has to be the one it builds for itself.
 */
function readBlind(input: GitHubLiveInput, limit: number): TicketSetRead {
	const blinded: Runner = (argv) => input.runner([...withoutBlockingField(argv)]);
	return readGitHubTicketSet({ runner: blinded, limit, repo: input.repo });
}

function observe(input: GitHubLiveInput): readonly LiveObservation[] {
	const rows = request(input.runner, openIssuesRequest(input.repo), `the open tickets of ${input.repo}`);
	return rows
		// A pull request is an issue on this endpoint and is not one on `gh issue list`, so it is dropped here to
		// leave the two sides reading the same set. As a *blocker* it still counts, and `blockersOf` keeps it.
		.filter((row) => row.pull_request === undefined || row.pull_request === null)
		.map((row, index) => observation(row, input, `${input.repo} open issue ${index}`));
}

function observation(row: Record<string, unknown>, input: GitHubLiveInput, where: string): LiveObservation {
	const key = String(number(row.number, `${where} number`));
	return {
		ref: { tracker: "github", repo: repoOf(text(row.repository_url, `${where} repository_url`), `${where} repository_url`), host: null, key },
		claimed: list(row.assignees, `${where} assignees`).length > 0,
		labels: list(row.labels, `${where} labels`).map((label, at) => text(object(label, `${where} labels[${at}]`).name, `${where} labels[${at}].name`)),
		blockers: blockersOf(input, key, `${where} blockers`),
	};
}

function blockersOf(input: GitHubLiveInput, key: string, where: string): readonly LiveObservedBlocker[] {
	return request(input.runner, blockedByRequest(input.repo, key), where).map((row, index) => {
		const at = `${where}[${index}]`;
		const repository = object(row.repository, `${at} repository`);
		return {
			ref: {
				tracker: "github",
				repo: text(repository.full_name, `${at} repository.full_name`),
				host: null,
				key: String(number(row.number, `${at} number`)),
			},
			open: state(row.state, `${at} state`),
		};
	});
}

/**
 * One slurped request's rows, with the pages flattened.
 *
 * @throws GitHubLiveError on any failure at all, including a connectivity one — `LiveObservation` has why an
 * expected answer may not degrade.
 */
function request(runner: Runner, argv: readonly string[], where: string): readonly Record<string, unknown>[] {
	const result = runner([...argv]);
	if (result.code !== 0) {
		throw new GitHubLiveError(`reading ${where} independently failed with exit ${result.code}: ${collapseFailure(result.stderr) || "no stderr"}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(result.stdout);
	} catch (cause) {
		throw new GitHubLiveError(`reading ${where} independently returned no JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (!Array.isArray(raw)) throw new GitHubLiveError(`reading ${where} independently returned ${typeof raw} where pages were asked for`);
	return raw.flatMap((page, index) => {
		if (!Array.isArray(page)) throw new GitHubLiveError(`${where} page ${index} is not a list`);
		return page.map((row, at) => object(row, `${where} page ${index} row ${at}`));
	});
}

/**
 * The owner and repository from an API collection address, taken as the two segments after `/repos/`.
 *
 * Deliberately a different field, read by different code, than the adapter's `addressRepo`: a rename or a
 * differently-cased spelling reaching only one of them is exactly the class of defect this check is for, and
 * sharing the parser would hide it.
 */
function repoOf(address: string, where: string): string {
	const repo = /\/repos\/([^/\s?#]+\/[^/\s?#]+)$/.exec(address)?.[1];
	if (repo === undefined) throw new GitHubLiveError(`${where} names no owner and repository: ${address}`);
	return repo;
}

function object(raw: unknown, where: string): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new GitHubLiveError(`${where} is not an object`);
	return raw as Record<string, unknown>;
}

function list(raw: unknown, where: string): readonly unknown[] {
	if (!Array.isArray(raw)) throw new GitHubLiveError(`${where} is not a list`);
	return raw;
}

function text(raw: unknown, where: string): string {
	if (typeof raw !== "string" || raw === "") throw new GitHubLiveError(`${where} is not a non-empty string`);
	return raw;
}

function number(raw: unknown, where: string): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new GitHubLiveError(`${where} is not a whole number`);
	return raw;
}

/**
 * Whether one blocker is open. This endpoint spells the state in lower case where `gh issue list --json` spells it
 * in upper, which is itself a reminder that these are two surfaces; case is folded rather than picked so that
 * neither spelling is what this depends on.
 */
function state(raw: unknown, where: string): boolean {
	const value = text(raw, where).toUpperCase();
	if (value === "OPEN") return true;
	if (value === "CLOSED") return false;
	throw new GitHubLiveError(`${where} is ${value}, which is neither open nor closed`);
}
