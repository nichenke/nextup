import { githubIssueListCommand } from "./command-builders";
import type { DependencyGraph, IssueId } from "./effective-blockedness";
import { classifyFailure } from "./failure-class";
import { resolveRepoFromOrigin } from "./git-remote";
import { type GraphSeed, seedGraph } from "./graph-store";
import type { Runner } from "./runner";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, isValidRepoPath } from "./ticket-ref";

export class GitHubAdapterError extends Error {}

/**
 * One read of a ticket set: the tickets, the blocking graph over them, and what the read could not answer.
 *
 * `truncated` and `outages` are separate because they call for different responses — a truncated read wants
 * a narrower query, an outage wants a look at the tracker — and because a read can be both.
 */
export interface TicketSetRead {
	readonly tickets: readonly Ticket[];
	/**
	 * Spans every blocker the read learned of, including ones outside `tickets`: a blocker the read stopped
	 * short of still gates its dependent, on the openness its own edge carried.
	 */
	readonly graph: DependencyGraph;
	/** Whether the read stopped short of the whole ticket set. */
	readonly truncated: boolean;
	/**
	 * Reads that failed open, each already reflected as `"unknown"` somewhere in `tickets` or as an empty
	 * set. Empty for a read that answered everything it was asked. A defect never reaches here — it throws.
	 */
	readonly outages: readonly string[];
}

export interface GitHubReadInput {
	readonly runner: Runner;
	/**
	 * How many tickets to consider. The read asks for one more, so a capped page is distinguishable from an
	 * exactly-full one. Required rather than defaulted: a default is a claim about somebody's backlog size.
	 */
	readonly limit: number;
	/** The `owner/repo` to read, or absent to resolve it from the working directory's git remote. */
	readonly repo?: string;
}

/**
 * Reads a GitHub ticket set through the `gh` CLI, normalized to `Ticket`s and a blocking graph.
 *
 * Blocking comes only from the native dependency edges `blockedBy` carries. Nothing here parses a body: a
 * prose declaration is not a blocking channel, which ADR-0025 records against the checklist that asked for
 * one and ADR-0020 argues from.
 *
 * @throws GitHubAdapterError on a defect — a request that is itself wrong, a repository that is not
 * `owner/repo`, or a response whose shape the adapter cannot read. An outage is flagged and continued past.
 */
export function readGitHubTicketSet(input: GitHubReadInput): TicketSetRead {
	if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
		throw new GitHubAdapterError(`${input.limit} is not a number of tickets to read: it must be a whole number above zero`);
	}
	const repo = resolveRepo(input);
	const result = input.runner([...githubIssueListCommand({ repo, rows: input.limit + 1 })]);
	if (result.code !== 0) return failedRead(repo, result.stderr);

	const rows = readRows(result.stdout, repo);
	const readings = rows.map((row, index) => readRow(row, repo, `${repo} row ${index}`));
	const tickets = readings.map((reading) => reading.ticket);
	const unreadable = tickets.filter((ticket) => ticket.blockers === "unknown").length;

	return {
		tickets,
		graph: seedGraph(seedsFor(readings)),
		// Decided on the raw read, before anything is filtered out of it.
		truncated: rows.length > input.limit,
		outages:
			unreadable === 0
				? []
				: [`${repo} answered with no readable blocking field for ${unreadable} of ${rows.length} tickets`],
	};
}

/**
 * An outage leaves a read that knows nothing, and says so as a truncated empty set rather than as a complete
 * one: an empty ticket set reported whole is indistinguishable from a tracker with no work in it.
 *
 * @throws GitHubAdapterError when the failure is a defect.
 */
function failedRead(repo: string, stderr: string): TicketSetRead {
	const detail = stderr.trim();
	if (classifyFailure(stderr) === "defect") {
		throw new GitHubAdapterError(`reading ${repo} failed, and the request itself is what is wrong: ${detail}`);
	}
	return { tickets: [], graph: seedGraph([]), truncated: true, outages: [`reading ${repo} failed as an outage: ${detail}`] };
}

function resolveRepo(input: GitHubReadInput): string {
	const repo = input.repo ?? resolveRepoFromOrigin(input.runner);
	if (repo === null) {
		throw new GitHubAdapterError("no repository was named, and the working directory's git remote could not be resolved");
	}
	if (!isValidRepoPath("github", repo)) {
		throw new GitHubAdapterError(`${repo} is not a GitHub owner and repository`);
	}
	return repo;
}

/** One row's normalization, and the openness its own edges reported for the blockers they name. */
interface RowReading {
	readonly ticket: Ticket;
	readonly edgeOpenness: ReadonlyMap<IssueId, boolean>;
}

/**
 * A seed per ticket, plus one per blocker the read itself did not return. Without the second group a blocker
 * outside the read has no openness at all, so the traversal degrades its dependent to `"unknown"` — and the
 * edge already carried the answer.
 */
function seedsFor(readings: readonly RowReading[]): readonly GraphSeed[] {
	const seeds: GraphSeed[] = [];
	const own = new Set<IssueId>();
	for (const { ticket } of readings) {
		const id = ticketId(ticket.ref);
		own.add(id);
		seeds.push({
			id,
			// Containment is not a blocking channel (ADR-0017), so nothing reads a parent; `null` is what the
			// port takes for that, and is not a claim that these tickets were checked and found to be roots.
			parent: null,
			blockers: ticket.blockers === "unknown" ? "unknown" : ticket.blockers.map(ticketId),
			open: ticket.state === "open",
		});
	}

	const outside = new Map<IssueId, boolean>();
	for (const { edgeOpenness } of readings) {
		for (const [id, open] of edgeOpenness) {
			// One read is one snapshot, so two edges naming the same blocker agree; deduplicating is what keeps
			// `seedGraph` from refusing the set for holding an id twice.
			if (!own.has(id)) outside.set(id, open);
		}
	}
	for (const [id, open] of outside) {
		// Its own blockers were never read, and saying so is the point: a closed one is pruned before they are
		// consulted, and an open one blocks on its own.
		seeds.push({ id, parent: null, blockers: "unknown", open });
	}
	return seeds;
}

function readRows(stdout: string, repo: string): readonly Record<string, unknown>[] {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (cause) {
		throw new GitHubAdapterError(`reading ${repo} returned no JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (!Array.isArray(raw)) throw new GitHubAdapterError(`reading ${repo} returned ${typeof raw} where a list of issues was asked for`);
	return raw.map((row, index) => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new GitHubAdapterError(`${repo} row ${index} is not an issue object`);
		}
		return row as Record<string, unknown>;
	});
}

function readRow(row: Record<string, unknown>, repo: string, where: string): RowReading {
	const ref: TicketRef = { tracker: "github", repo, host: null, key: String(number(row.number, `${where} number`)) };
	const edges = readEdges(row.blockedBy, where);
	return {
		ticket: {
			ref,
			title: text(row.title, `${where} title`),
			state: state(row.state, `${where} state`),
			claim: readClaim(row.assignees, where),
			blockers: edges.blockers,
			url: url(row.url, `${where} url`),
			labels: readLabels(row.labels, where),
		},
		edgeOpenness: edges.openness,
	};
}

interface EdgeReading {
	readonly blockers: readonly TicketRef[] | "unknown";
	readonly openness: ReadonlyMap<IssueId, boolean>;
}

/**
 * The blocking edges one row carries, or `"unknown"`.
 *
 * `"unknown"` comes from the field being absent rather than from it being empty, which is the distinction
 * `docs/agents/issue-tracker.md` warns this surface does not draw for us: `{nodes:[],totalCount:0}` is what
 * an issue with no blockers returns and there is no separate value for a dependency surface that could not
 * answer, so reading a zero as unknown would make every unblocked ticket unknown, and reading an absent
 * field as zero is the collapse `CONTEXT.md` forbids.
 *
 * @throws GitHubAdapterError when the field is present in a shape this cannot read — that is our query being
 * wrong rather than the tracker being unavailable.
 */
function readEdges(raw: unknown, where: string): EdgeReading {
	if (raw === undefined || raw === null) return { blockers: "unknown", openness: new Map() };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new GitHubAdapterError(`${where} blockedBy is not a blocking field`);

	const field = raw as Record<string, unknown>;
	const nodes = field.nodes;
	const total = number(field.totalCount, `${where} blockedBy.totalCount`);
	if (!Array.isArray(nodes)) throw new GitHubAdapterError(`${where} blockedBy.nodes is not a list of blockers`);
	// A node list shorter than the count it reports is a page of the edges rather than all of them, which
	// reads as a shorter list of blockers and so as unblocked. The tree cannot reach this — it would take more
	// blockers on one issue than the CLI returns per issue — and ADR-0019 takes that inability as information
	// about the shape rather than licence to hand-write one, so this is a guard with no recording behind it.
	if (nodes.length !== total) return { blockers: "unknown", openness: new Map() };

	const blockers: TicketRef[] = [];
	const openness = new Map<IssueId, boolean>();
	for (const [index, node] of nodes.entries()) {
		if (typeof node !== "object" || node === null || Array.isArray(node)) {
			throw new GitHubAdapterError(`${where} blockedBy.nodes[${index}] is not a blocker`);
		}
		const blocker = node as Record<string, unknown>;
		const ref: TicketRef = {
			tracker: "github",
			// The blocker's own repository, read from its address rather than assumed to be the one being read:
			// a dependency may name an issue in another repository, and keying it under this one would land two
			// different tickets on one graph node.
			repo: blockerRepo(blocker.url, `${where} blockedBy.nodes[${index}]`),
			host: null,
			key: String(number(blocker.number, `${where} blockedBy.nodes[${index}] number`)),
		};
		blockers.push(ref);
		openness.set(ticketId(ref), state(blocker.state, `${where} blockedBy.nodes[${index}] state`) === "open");
	}
	return { blockers, openness };
}

// The owner and repository from an issue address, taken as the two segments before "/issues/<number>" rather
// than by parsing a URL: a stored recording has had its host and scheme replaced by a placeholder, so what
// this reads live is not a parseable URL by the time a test reads it — ADR-0024.
const ISSUE_ADDRESS = /([^/\s]+\/[^/\s]+)\/issues\/\d+$/;

function blockerRepo(raw: unknown, where: string): string {
	const address = text(raw, `${where} url`);
	const repo = ISSUE_ADDRESS.exec(address)?.[1];
	if (repo === undefined) throw new GitHubAdapterError(`${where} url names no owner and repository: ${address}`);
	return repo;
}

/**
 * The claim, from the assignees. A ticket with several assignees is claimed by the first of them: which one
 * is reported is display, and every reading that decides anything asks only whether a claim exists.
 */
function readClaim(raw: unknown, where: string): Claim | null {
	if (raw === undefined) throw new GitHubAdapterError(`${where} carries no assignees, so its claim cannot be read`);
	if (!Array.isArray(raw)) throw new GitHubAdapterError(`${where} assignees is not a list`);
	const first = raw[0];
	if (first === undefined) return null;
	if (typeof first !== "object" || first === null) throw new GitHubAdapterError(`${where} assignees[0] is not an account`);
	return { by: text((first as Record<string, unknown>).login, `${where} assignees[0].login`) };
}

function readLabels(raw: unknown, where: string): readonly string[] {
	if (raw === undefined) throw new GitHubAdapterError(`${where} carries no labels field`);
	if (!Array.isArray(raw)) throw new GitHubAdapterError(`${where} labels is not a list`);
	return raw.map((label, index) => {
		if (typeof label !== "object" || label === null) throw new GitHubAdapterError(`${where} labels[${index}] is not a label`);
		return text((label as Record<string, unknown>).name, `${where} labels[${index}].name`);
	});
}

function text(raw: unknown, where: string): string {
	if (typeof raw !== "string") throw new GitHubAdapterError(`${where} is not a string`);
	return raw;
}

/** A ticket with no web address is a tracker without a web UI, which GitHub is not — so an empty one is not it. */
function url(raw: unknown, where: string): string {
	const address = text(raw, where);
	if (address === "") throw new GitHubAdapterError(`${where} is empty`);
	return address;
}

function number(raw: unknown, where: string): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
		throw new GitHubAdapterError(`${where} is not a whole number`);
	}
	return raw;
}

/**
 * Open or closed, and nothing else. `Ticket` carries no unknown state on purpose: defaulting an unconfirmed
 * one to open advertises somebody else's finished work as available, so an unreadable state refuses the read.
 */
function state(raw: unknown, where: string): "open" | "closed" {
	const value = text(raw, where).toUpperCase();
	if (value === "OPEN") return "open";
	if (value === "CLOSED") return "closed";
	throw new GitHubAdapterError(`${where} is ${value || "empty"}, which is neither open nor closed`);
}
