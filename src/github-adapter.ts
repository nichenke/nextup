import { githubIssueListCommand } from "./command-builders";
import type { DependencyGraph, IssueId } from "./effective-blockedness";
import { classifyFailure } from "./failure-class";
import { resolveOriginRemote } from "./git-remote";
import { type GraphSeed, seedGraph } from "./graph-store";
import type { Runner } from "./runner";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { GITHUB_HOST, type TicketRef, isGitHubHost, isValidRepoPath } from "./ticket-ref";

export class GitHubAdapterError extends Error {}

/**
 * A way one read answered with less than it was asked. Kinds rather than sentences, following how `Degrade` and
 * `DEGRADE_REASON` divide the same job: a caller decides on the kind, and only a render boundary writes prose.
 * A test asserting wording instead pins text `selection-output.ts` declares free to change.
 *
 * No render boundary reads these yet — `DEGRADE_REASON` is keyed on the selector's own union — so a caller
 * wiring this adapter to the command has to add the sibling mapping. Nothing outside this module consumes a
 * `TicketSetRead` today.
 *
 * `outage` is the only one named for a failure of the call. The other two are the tracker answering, with less
 * than one answer in it — which is why neither is filed under a word `failure-class.ts` reserves for
 * connectivity and the tracker erroring.
 */
export type ReadDegrade =
	| { readonly kind: "outage"; readonly detail: string }
	| { readonly kind: "unreadable-blocking"; readonly tickets: number; readonly of: number }
	/** Tickets held out of the answer because only a page of their blockers arrived — never recommended. */
	| { readonly kind: "partial-blocking"; readonly refs: readonly TicketRef[] }
	| { readonly kind: "contradicted-blocker"; readonly refs: readonly TicketRef[] };

/**
 * One read of a ticket set: the tickets, the blocking graph over them, and what the read could not answer.
 *
 * `truncated` is separate from `degraded` because it calls for a different response — a narrower query rather
 * than a look at the tracker — and because a read can be both. Neither implies the other: an outage reports
 * both, while a read whose blocking nothing could confirm is degraded and complete. So a caller has to consult
 * both, and `truncated === false` is not a claim that the answer is whole.
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
	 * Every way this read answered with less than it was asked, each already reflected as `"unknown"` in
	 * `tickets` or in `graph`, or as an empty set. Empty for a read that answered everything. A defect never
	 * reaches here — it throws.
	 */
	readonly degraded: readonly ReadDegrade[];
}

export interface GitHubReadInput {
	readonly runner: Runner;
	/**
	 * How many tickets to consider, and a bound on how many come back. The read asks for one more so that a
	 * capped page is distinguishable from an exactly-full one, and drops that row again before anyone sees it.
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
	// The over-fetched row is bounded here rather than left to the command builder: past the safe-integer range
	// `limit + 1` is refused there instead, with the wrong error class for a caller reading this contract.
	if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.limit + 1)) {
		throw new GitHubAdapterError(`${input.limit} is not a number of tickets to read: it must be a whole number above zero`);
	}
	const repo = resolveRepo(input);
	const result = input.runner([...githubIssueListCommand({ repo, rows: input.limit + 1 })]);
	if (result.code !== 0) return failedRead(repo, result.stderr);

	const rows = readRows(result.stdout, repo);
	const readings = rows.map((row, index) => readRow(row, `${repo} row ${index}`));
	requireOneRepository(readings, repo);

	// Every row seeds the graph, including the probe row and any ticket held back below: a row is its own
	// authority on being open, and dropping one from the graph leaves a dependent's edge — a copy, which can be
	// stale — to answer for it instead. Seeding all of them and narrowing only what may be recommended is what
	// keeps the row-over-edge precedence from depending on where the page happened to end.
	const { graph, contradicted } = graphFor(readings);

	// Truncation is decided on the raw read; `limit` then bounds what comes back, because a row fetched only to
	// detect a cap must not become the recommendation.
	const truncated = rows.length > input.limit;
	const considered = readings.slice(0, input.limit);
	const partial = considered.filter((reading) => reading.edges === "partial").map((reading) => reading.ticket.ref);
	const tickets = considered.filter((reading) => reading.edges !== "partial").map((reading) => reading.ticket);
	// Counted from the edges rather than from the tickets' `blockers`, which mirror them: the graph is seeded
	// from the edges, so counting the mirror would let the two disagree with nothing to catch it.
	const unreadable = considered.filter((reading) => reading.edges === "unknown").length;

	const degraded: ReadDegrade[] = [];
	if (unreadable > 0) degraded.push({ kind: "unreadable-blocking", tickets: unreadable, of: considered.length });
	if (partial.length > 0) degraded.push({ kind: "partial-blocking", refs: partial });
	if (contradicted.length > 0) degraded.push({ kind: "contradicted-blocker", refs: contradicted });

	return { tickets, graph, truncated, degraded };
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
		// Not "the request is wrong": a missing or unauthenticated `gh` lands here too, and the fix is neither the
		// query nor a retry.
		throw new GitHubAdapterError(`reading ${repo} failed with something a retry will not fix: ${detail}`);
	}
	return { tickets: [], graph: seedGraph([]), truncated: true, degraded: [{ kind: "outage", detail }] };
}

/**
 * The repository to read: the one named, or the one the working directory's origin points at.
 *
 * A resolved remote has to be on GitHub, and that check is the point rather than a formality. The remote's
 * host is not carried into the query, so a checkout on a GitHub Enterprise or GitLab host resolves to a bare
 * `owner/repo` indistinguishable from a github.com one — and the read then answers with whatever public
 * repository happens to sit at that path, which is somebody else's work presented as this project's.
 */
function resolveRepo(input: GitHubReadInput): string {
	const repo = input.repo ?? requireGitHubOrigin(input.runner);
	if (!isValidRepoPath("github", repo)) {
		throw new GitHubAdapterError(`${repo} is not a GitHub owner and repository`);
	}
	return repo;
}

/**
 * Refuses a read whose rows do not all name one repository. `ticketId` requires that refs entering one graph
 * agree on how much they know, and taking each ref's repository from its own row is what stopped enforcing
 * that for free — every ref used to carry the one repository the caller asked about. The rows may name a
 * different repository than was asked for, since a rename redirects and the tracker answers under the new
 * name; what they may not do is disagree with each other.
 */
function requireOneRepository(readings: readonly RowReading[], asked: string): void {
	const named = new Set(readings.map((reading) => reading.ticket.ref.repo));
	if (named.size > 1) {
		throw new GitHubAdapterError(`reading ${asked} answered for more than one repository: ${[...named].sort().join(", ")}`);
	}
}

function requireGitHubOrigin(runner: Runner): string {
	const origin = resolveOriginRemote(runner);
	if (origin === null) {
		throw new GitHubAdapterError("no repository was named, and the working directory's git remote could not be resolved");
	}
	if (!isGitHubHost(origin.host)) {
		throw new GitHubAdapterError(
			`the origin remote points at ${origin.host}, and this adapter reads ${GITHUB_HOST} only — reading ${origin.repo} here would answer about a different repository of the same name`,
		);
	}
	return origin.repo;
}

interface Edge {
	readonly ref: TicketRef;
	readonly open: boolean;
}

/**
 * What one row's blocking field said: its edges, or why they are not a list. `"unknown"` is a field that did not
 * answer, `"partial"` a field that answered with a page of a longer list — see `readEdges` for why they differ.
 */
type EdgeReading = readonly Edge[] | "unknown" | "partial";

interface RowReading {
	readonly ticket: Ticket;
	readonly edges: EdgeReading;
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
		if (typeof edges === "string") continue;
		for (const edge of edges) {
			const id = ticketId(edge.ref);
			// A blocker the read returned answers for its own openness, and an edge disagreeing with it is
			// discarded rather than reconciled: the row is the tracker's own per-ticket state, where the edge is
			// one dependent's copy of it.
			if (own.has(id)) continue;
			const seen = outside.get(id);
			// Two edges disagreeing is the tracker telling us two things, so neither is taken: keeping either decides
			// one dependent's blocking state from another dependent's edge. ADR-0025 has why not the open one.
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

function readRow(row: Record<string, unknown>, where: string): RowReading {
	const address = url(row.url, `${where} url`);
	const ref: TicketRef = {
		tracker: "github",
		repo: addressRepo(address, `${where} url`),
		host: null,
		key: String(number(row.number, `${where} number`)),
	};
	const edges = readEdges(row.blockedBy, where);
	return {
		ticket: {
			ref,
			title: text(row.title, `${where} title`),
			state: state(row.state, `${where} state`),
			claim: readClaim(row.assignees, where),
			blockers: typeof edges === "string" ? "unknown" : edges.map((edge) => edge.ref),
			url: address,
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
function readEdges(raw: unknown, where: string): EdgeReading {
	if (raw === undefined || raw === null) return "unknown";
	if (typeof raw !== "object" || Array.isArray(raw)) throw new GitHubAdapterError(`${where} blockedBy is not a blocking field`);

	const field = raw as Record<string, unknown>;
	const nodes = field.nodes;
	const total = number(field.totalCount, `${where} blockedBy.totalCount`);
	if (!Array.isArray(nodes)) throw new GitHubAdapterError(`${where} blockedBy.nodes is not a list of blockers`);
	// A node list shorter than the count beside it is a page of the edges rather than all of them, and neither
	// reading of it is available: the retained edges may hold a confirmed open blocker, so `"unknown"` would
	// demote a confirmed block, and the missing ones may hold one too, so the retained list alone reads
	// unblocked. So this ticket is not judged at all — `"partial"` holds it out of the answer, which is a
	// narrower refusal than failing the read and losing every other ticket with it. ADR-0025 has both.
	if (nodes.length !== total) return "partial";

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
			repo: addressRepo(text(blocker.url, `${at} url`), `${at} url`),
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
//
// `pull` is accepted beside `issues` because GitHub numbers both in one space, so a pull request blocking an
// issue is a ticket at that number like any other.
const ISSUE_ADDRESS = /([^/\s?#]+\/[^/\s?#]+)\/(?:issues|pull)\/\d+$/;

// A query, fragment or trailing slash addresses a place within the page rather than another page, so it is
// removed before matching rather than tolerated inside the pattern. Tolerating it there made `exec` take the
// leftmost pair, so an address holding two issue numbers resolved to the repository before the first.
const ADDRESS_TAIL = /[?#].*$|\/+$/;

/**
 * The owner and repository an issue address names, which is where every ref's repository comes from — a row's
 * as much as a blocker's. Both have to be read the same way: a blocker's repository can only come from its
 * address, so taking a row's from the repository the caller asked about instead let one issue occupy two graph
 * nodes. ADR-0025 has what made that silent.
 */
function addressRepo(address: string, where: string): string {
	const repo = ISSUE_ADDRESS.exec(address.replace(ADDRESS_TAIL, ""))?.[1];
	if (repo === undefined) throw new GitHubAdapterError(`${where} names no owner and repository: ${address}`);
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
