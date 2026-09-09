import { githubIssueListCommand } from "./command-builders";
import type { DependencyGraph, IssueId } from "./effective-blockedness";
import { classifyFailure } from "./failure-class";
import { resolveRepoFromOrigin } from "./git-remote";
import { type GraphSeed, seedGraph } from "./graph-store";
import type { Runner } from "./runner";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, formatTicketRef, isValidRepoPath } from "./ticket-ref";

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
	/**
	 * Whether the read stopped short of the whole ticket set. An outage sets it, because a read that returned
	 * nothing has stopped short of everything — but nothing in the type enforces that pairing, so a second
	 * adapter copying this shape has to keep it by hand.
	 */
	readonly truncated: boolean;
	/**
	 * Reads that failed open, each already reflected as `"unknown"` somewhere in `tickets` or in `graph`, or
	 * as an empty set. Empty for a read that answered everything. A defect never reaches here — it throws.
	 */
	readonly outages: readonly string[];
}

export interface GitHubReadInput {
	readonly runner: Runner;
	/**
	 * How many tickets to consider. The read asks for one more, so a capped page is distinguishable from an
	 * exactly-full one, and keeps that extra row: it is a ticket like any other, and dropping one already in
	 * hand is a second truncation. A truncated read therefore returns `limit + 1` tickets.
	 *
	 * Required rather than defaulted: a default is a claim about somebody's backlog size.
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
 * @throws GitHubAdapterError on a defect — a limit that is not a positive whole number, a repository that is
 * not `owner/repo` or that no remote resolves to, a request the tracker rejects, or a response whose shape
 * cannot be read. An outage is flagged and continued past instead.
 * @throws Error from `seedGraph` when the read holds one issue twice, which is an identity failure rather
 * than a tracker one — `graph-store.ts` says why that refuses instead of taking the last write.
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
	// Counted from the edges rather than from the tickets' `blockers`, which mirror them: the graph is seeded
	// from the edges, so counting the mirror would let the two disagree with nothing to catch it.
	const unreadable = readings.filter((reading) => reading.edges === "unknown").length;
	const { graph, contradicted } = graphFor(readings);

	const outages: string[] = [];
	if (unreadable > 0) {
		outages.push(`${repo} answered with no readable blocking field for ${unreadable} of ${rows.length} tickets`);
	}
	if (contradicted.length > 0) {
		outages.push(
			`${repo} reported one blocker as both open and closed within one read: ${contradicted.map(formatTicketRef).join(", ")}`,
		);
	}

	return { tickets, graph, truncated: rows.length > input.limit, outages };
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

/** One blocker an edge named, carrying the openness that edge reported for it. */
interface Edge {
	readonly ref: TicketRef;
	readonly open: boolean;
}

/** One row's normalization, and its edges — `"unknown"` where the blocking field did not answer at all. */
interface RowReading {
	readonly ticket: Ticket;
	readonly edges: readonly Edge[] | "unknown";
}

interface GraphReading {
	readonly graph: DependencyGraph;
	/** Blockers outside the read whose edges disagreed about openness, each seeded unknown instead. */
	readonly contradicted: readonly TicketRef[];
}

/**
 * The graph: a seed per ticket, plus one per blocker the read itself did not return. Without that second
 * group a blocker outside the read has no openness at all, so the traversal degrades its dependent to
 * `"unknown"` — and the edge already carried the answer.
 */
function graphFor(readings: readonly RowReading[]): GraphReading {
	const seeds: GraphSeed[] = [];
	const own = new Set<IssueId>();
	for (const { ticket } of readings) {
		const id = ticketId(ticket.ref);
		own.add(id);
		seeds.push({
			id,
			// Containment is not a blocking channel (ADR-0017), so no parentage is read and every ticket is
			// seeded as a confirmed root — which is what makes the traversal's ancestor walk stop at one hop.
			parent: null,
			blockers: ticket.blockers === "unknown" ? "unknown" : ticket.blockers.map(ticketId),
			open: ticket.state === "open",
		});
	}

	const outside = new Map<IssueId, { readonly ref: TicketRef; readonly open: boolean | "unknown" }>();
	for (const { edges } of readings) {
		if (edges === "unknown") continue;
		for (const edge of edges) {
			const id = ticketId(edge.ref);
			// A blocker the read returned answers for its own openness, and an edge disagreeing with it is
			// discarded rather than reconciled: the row is the tracker's own per-ticket state, where the edge is
			// one dependent's copy of it.
			if (own.has(id)) continue;
			const seen = outside.get(id);
			// Two edges disagreeing is the tracker telling us two things, so neither is taken. Keeping either
			// decides one dependent's blocking state from another's edge — and last-write-wins reported a ticket
			// unblocked whose own edge said its blocker was open. Reading the pair as open instead would be safe
			// in that direction and wrong in the other, withholding work whose blocker had in fact just closed;
			// `unknown` is what CONTEXT.md reserves for the tracker not telling us one thing.
			outside.set(id, { ref: edge.ref, open: seen === undefined || seen.open === edge.open ? edge.open : "unknown" });
		}
	}

	const contradicted: TicketRef[] = [];
	for (const [id, blocker] of outside) {
		if (blocker.open === "unknown") contradicted.push(blocker.ref);
		// Its own blockers were never read, and saying so is the point: a closed one is pruned before they are
		// consulted, and an open one blocks on its own.
		seeds.push({ id, parent: null, blockers: "unknown", open: blocker.open });
	}
	return { graph: seedGraph(seeds), contradicted };
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
			blockers: edges === "unknown" ? "unknown" : edges.map((edge) => edge.ref),
			url: url(row.url, `${where} url`),
			labels: readLabels(row.labels, where),
		},
		edges,
	};
}

/**
 * The blocking edges one row carries: an absent field reads `"unknown"`, an empty one reads no blockers, and
 * a node list shorter than its own count reads `"unknown"` too. ADR-0025 has why each, and why the empty case
 * is not the unknown one.
 *
 * @throws GitHubAdapterError when the field is present in a shape this cannot read — that is our query being
 * wrong rather than the tracker being unavailable.
 */
function readEdges(raw: unknown, where: string): readonly Edge[] | "unknown" {
	if (raw === undefined || raw === null) return "unknown";
	if (typeof raw !== "object" || Array.isArray(raw)) throw new GitHubAdapterError(`${where} blockedBy is not a blocking field`);

	const field = raw as Record<string, unknown>;
	const nodes = field.nodes;
	const total = number(field.totalCount, `${where} blockedBy.totalCount`);
	if (!Array.isArray(nodes)) throw new GitHubAdapterError(`${where} blockedBy.nodes is not a list of blockers`);
	// A node list shorter than the count beside it is a page of the edges rather than all of them, and a
	// shorter list of blockers is what reads as unblocked. No recording reaches this — ADR-0025.
	if (nodes.length !== total) return "unknown";

	const edges: Edge[] = [];
	for (const [index, node] of nodes.entries()) {
		const at = `${where} blockedBy.nodes[${index}]`;
		if (typeof node !== "object" || node === null || Array.isArray(node)) {
			throw new GitHubAdapterError(`${at} is not a blocker`);
		}
		const blocker = node as Record<string, unknown>;
		const ref: TicketRef = {
			tracker: "github",
			// The blocker's own repository, read from its address rather than assumed to be the one being read:
			// a dependency may name an issue in another repository, and keying it under this one would land two
			// different tickets on one graph node.
			repo: blockerRepo(blocker.url, at),
			host: null,
			key: String(number(blocker.number, `${at} number`)),
		};
		edges.push({ ref, open: state(blocker.state, `${at} state`) === "open" });
	}
	return edges;
}

// The owner and repository from an issue address, taken as the two segments before "/issues/<number>" rather
// than by parsing a URL: a stored recording has had its host and scheme replaced by a placeholder, so what
// this reads live is not a parseable URL by the time a test reads it — ADR-0024. `ticket-ref.ts`'s
// GENERIC_ISSUES_URL parses the same path from a *pasted* URL and cannot be reused for that reason: it
// requires the scheme and authority this address has lost, and resolves a tracker from the host besides.
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

/** `Ticket.url` is null only for a tracker with no web UI, so from GitHub an empty address is a bad response. */
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
