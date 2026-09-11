import { GITHUB_TICKET_STATE, githubIssueListCommand, githubIssueViewCommand } from "./command-builders";
import type { DependencyGraph, IssueId } from "./effective-blockedness";
import { classifyFailure, collapseFailure, failureDetail } from "./failure-class";
import { resolveOriginRemote } from "./git-remote";
import { type GraphSeed, seedGraph } from "./graph-store";
import type { CommandResult, Runner } from "./runner";
import { type Claim, type Ticket, ticketId } from "./ticket";
import type { ReadDegrade, TicketRead, TicketSetRead } from "./ticket-set-read";
import { GITHUB_HOST, type TicketRef, formatTicketRef, githubTicketTarget, isGitHubHost, isValidRepoPath } from "./ticket-ref";

export class GitHubAdapterError extends Error {}

/** Read off the query rather than asserted beside it, so the two cannot come to disagree. */
const OPEN_ONLY = GITHUB_TICKET_STATE === "open";

/**
 * Whether a limit is one this read can use: a whole number above zero whose over-fetched row is still a safe
 * integer, since the read asks for `limit + 1` to tell a capped page from an exactly-full one.
 *
 * Exported because `cli.ts` refuses a bad `--limit` before the read, so that a mistyped flag reads as a bad
 * invocation rather than as a tracker read that would not run. A second copy of this bound there would be a
 * promise nothing enforces — the two would drift with no compiler error.
 */
export function isReadableLimit(limit: number): boolean {
	return Number.isSafeInteger(limit) && limit >= 1 && Number.isSafeInteger(limit + 1);
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
 * prose declaration is not a blocking channel, which ADR-0027 records against the checklist that asked for
 * one and ADR-0020 argues from.
 *
 * @throws GitHubAdapterError on a defect — a limit that is not a positive whole number, a repository that is
 * not `owner/repo` or that no remote resolves to, a request the tracker rejects, a response whose shape
 * cannot be read, or one holding two rows for one issue. An outage is flagged and continued past instead.
 */
export function readGitHubTicketSet(input: GitHubReadInput): TicketSetRead {
	if (!isReadableLimit(input.limit)) {
		throw new GitHubAdapterError(`${input.limit} is not a number of tickets to read: it must be a whole number above zero`);
	}
	const repo = resolveRepo(input);
	const result = input.runner([...githubIssueListCommand({ repo, rows: input.limit + 1 })]);
	if (result.code !== 0) return failedRead(repo, result.stderr);

	const rows = readRows(result.stdout, repo);
	const readings = rows.map((row, index) => readRow(row, `${repo} row ${index}`));
	requireOneRepository(readings, repo);
	requireOneRowPerIssue(readings, repo);
	requireEveryRowOpen(readings, repo);

	// Truncation is decided on the raw read; `limit` then bounds what comes back, because a row fetched only to
	// detect a cap must not become the recommendation.
	const truncated = rows.length > input.limit;
	const considered = readings.slice(0, input.limit);

	// Every row seeds the graph, including the probe row and any ticket held back below: a row is its own
	// authority on being open, and dropping one from the graph leaves a dependent's edge — a copy, which can be
	// stale — to answer for it instead. Seeding all of them and narrowing only what may be recommended is what
	// keeps the row-over-edge precedence from depending on where the page happened to end.
	const { graph, contradicted } = graphFor(readings, considered);
	const partial = considered.filter((reading) => reading.edges === "partial").map((reading) => reading.ticket.ref);
	const tickets = considered.filter((reading) => reading.edges !== "partial").map((reading) => reading.ticket);
	// Counted from the edges rather than from the tickets' `blockers`, which mirror them: the graph is seeded
	// from the edges, so counting the mirror would let the two disagree with nothing to catch it.
	const unreadable = considered.filter((reading) => reading.edges === "unknown").length;

	const degraded: ReadDegrade[] = [];
	if (unreadable > 0) degraded.push({ kind: "unreadable-blocking", tickets: unreadable, of: considered.length });
	if (partial.length > 0) degraded.push({ kind: "partial-blocking", refs: partial });
	if (contradicted.length > 0) degraded.push({ kind: "contradicted-blocker", refs: contradicted });

	return { tickets, graph, truncated, openOnly: OPEN_ONLY, degraded };
}

export interface GitHubTicketReadInput {
	readonly runner: Runner;
	/** The ticket to read, which names its own repository — the override path resolved it before getting here. */
	readonly ref: TicketRef;
}

/**
 * Reads one named GitHub ticket through the `gh` CLI, normalized the same way a set read's rows are.
 *
 * For the override path, and its own call rather than a lookup inside a set read: that read asks for open
 * tickets only, within a limit, in the repository the origin resolves to, so a closed, older or elsewhere
 * ticket would come back absent rather than as the refusal it is. ADR-0037 has the whole reasoning.
 *
 * Both failure classes throw, unlike the set read, which flags an outage and carries on with less known: the
 * one ticket is the entire answer here, so there is nothing to continue with. `claimGitHubTicket` aborts on
 * both for the same reason, and the message is what says which it was.
 *
 * @throws GitHubAdapterError on a reference no GitHub command can act on, a call that failed either way, a
 * response that is not one issue object, and one answering about a different issue than was named.
 * @throws CommandBuilderError when the reference's key is not a canonical issue number, unwrapped for the
 * reason `github-claim.ts` leaves the claim's unwrapped: the stack names the builder, per ADR-0032.
 */
export function readGitHubTicket(input: GitHubTicketReadInput): TicketRead {
	const target = githubTicketTarget(input.ref);
	if (target.kind === "refused") throw new GitHubAdapterError(target.reason);

	const named = formatTicketRef(input.ref);
	const result = input.runner([...githubIssueViewCommand(target)]);
	if (result.code !== 0) throw failedTicketRead(named, result);

	const reading = readRow(readOneRow(result.stdout, named), named);
	// The row's own number rather than the one asked for, because everything downstream acts on what came back:
	// a mismatch means `--` and the canonical-key guard did not make the question total after all, and claiming
	// from this read would then claim an issue the reference does not name.
	if (reading.ticket.ref.key !== target.key) {
		throw new GitHubAdapterError(`reading ${named} answered about issue ${reading.ticket.ref.key}`);
	}

	const { graph, contradicted } = graphForOne(reading);
	const degraded: ReadDegrade[] = [];
	if (reading.edges === "unknown") degraded.push({ kind: "unreadable-blocking", tickets: 1, of: 1 });
	if (reading.edges === "partial") degraded.push({ kind: "partial-blocking", refs: [reading.ticket.ref] });
	if (contradicted.length > 0) degraded.push({ kind: "contradicted-blocker", refs: contradicted });

	return { ticket: reading.ticket, graph, degraded };
}

/**
 * @throws GitHubAdapterError always — whichever class the failure was. Worded from the class so the two are
 * told apart by what to do about them: a defect needs the request or the setup fixed, an outage a retry.
 */
function failedTicketRead(named: string, result: CommandResult): GitHubAdapterError {
	const detail = failureDetail(result);
	// Not "the request is wrong": a ticket that is not there lands here beside a missing or unauthenticated
	// `gh`, and neither is fixed by retrying.
	return classifyFailure(result.stderr) === "defect"
		? new GitHubAdapterError(`reading ${named} failed with something a retry will not fix: ${detail}`)
		: new GitHubAdapterError(`reading ${named} failed because the tracker could not be reached: ${detail}`);
}

/** @throws GitHubAdapterError when the response is not the single issue object the view asks for. */
function readOneRow(stdout: string, named: string): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (cause) {
		throw new GitHubAdapterError(`reading ${named} returned no JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new GitHubAdapterError(`reading ${named} returned ${Array.isArray(raw) ? "a list" : typeof raw} where one issue was asked for`);
	}
	return raw as Record<string, unknown>;
}

/** The graph over one ticket: its own seed, plus one per blocker its edges named. */
function graphForOne(reading: RowReading): GraphReading {
	const id = ticketId(reading.ticket.ref);
	const { seeds, contradicted } = blockerSeeds([reading.edges], new Set([id]));
	return {
		graph: seedGraph([
			{
				id,
				// Containment is not a blocking channel (ADR-0017), so the walk stops at one hop here as it does there.
				parent: null,
				blockers: reading.ticket.blockers === "unknown" ? "unknown" : reading.ticket.blockers.map(ticketId),
				open: reading.ticket.state === "open",
			},
			...seeds,
		]),
		contradicted,
	};
}

/**
 * Refuses a response holding one issue twice, which `seedGraph` would refuse a moment later with a plain
 * `Error` no caller can classify. Checked rather than caught: catching there would relabel a genuine bug in
 * graph construction as a bad tracker response, and cost it the stack `cli.ts` keeps for exactly that.
 */
function requireOneRowPerIssue(readings: readonly RowReading[], repo: string): void {
	const seen = new Set<IssueId>();
	for (const { ticket } of readings) {
		const id = ticketId(ticket.ref);
		if (seen.has(id)) {
			throw new GitHubAdapterError(`reading ${repo} returned more than one row for ${formatTicketRef(ticket.ref)}`);
		}
		seen.add(id);
	}
}

/**
 * Refuses a closed row when the query asked for open tickets only, over every row the response held rather
 * than over what is handed back. `select` refuses the same thing, but only sees the narrowed set: a closed row
 * held out for partial blocking, or sliced off past the limit, never reaches it — and the answer then reports
 * `closed not asked` over a response that contained a closed ticket, which is the reading ADR-0028 forbids.
 */
function requireEveryRowOpen(readings: readonly RowReading[], repo: string): void {
	if (!OPEN_ONLY) return;
	const closed = readings.find((reading) => reading.ticket.state === "closed");
	if (closed !== undefined) {
		throw new GitHubAdapterError(
			`reading ${repo} answered with ${formatTicketRef(closed.ticket.ref)} closed, though it asked for open tickets only`,
		);
	}
}

/**
 * An outage leaves a read that knows nothing, and says so as a truncated empty set rather than as a complete
 * one: an empty ticket set reported whole is indistinguishable from a tracker with no work in it.
 *
 * @throws GitHubAdapterError when the failure is a defect.
 */
function failedRead(repo: string, stderr: string): TicketSetRead {
	// Collapsed rather than left to a render boundary, so `ReadDegrade.detail` is one line by construction.
	const detail = collapseFailure(stderr);
	if (classifyFailure(stderr) === "defect") {
		// Not "the request is wrong": a missing or unauthenticated `gh` lands here too, and the fix is neither the
		// query nor a retry.
		throw new GitHubAdapterError(`reading ${repo} failed with something a retry will not fix: ${detail}`);
	}
	return { tickets: [], graph: seedGraph([]), truncated: true, openOnly: OPEN_ONLY, degraded: [{ kind: "outage", detail }] };
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
 * Refuses a read whose rows do not all name one repository, which is `ticketId`'s requirement that refs
 * entering one graph agree on how much they know. The rows may name a different repository than was asked for,
 * since a rename redirects and the tracker answers under the new name; what they may not do is disagree with
 * each other.
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
function graphFor(readings: readonly RowReading[], considered: readonly RowReading[]): GraphReading {
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

	// From `considered` rather than from every row: the over-fetched probe row exists to reveal a cap, and its
	// edges are one more dependent's copy of some third ticket's state. Let them vote and the row fetched only
	// to detect truncation decides the answer — a probe whose edge disagreed with a considered ticket's edge
	// seeded that blocker `"unknown"`, demoted the ticket off the confirmed partition, and changed the pick.
	const outside = blockerSeeds(
		considered.map((reading) => reading.edges),
		own,
	);
	return { graph: seedGraph([...seeds, ...outside.seeds]), contradicted: outside.contradicted };
}

/**
 * A seed per blocker named by an edge and not already seeded from its own row, on the openness that edge
 * carried. Without these a blocker outside the read has no openness at all, so the traversal degrades its
 * dependent to `"unknown"` — and the edge already carried the answer.
 *
 * Shared by both reads so that one rule decides what an edge is worth: a row answers for its own openness and
 * an edge disagreeing with it is discarded rather than reconciled, since the row is the tracker's own
 * per-ticket state where the edge is one dependent's copy of it. Two edges disagreeing is the tracker telling
 * us two things, so neither is taken — ADR-0027 has why not the open one.
 *
 * Deduplicating is not only for that: `seedGraph` refuses a repeated id outright, so one blocker named twice
 * would abort a read that is perfectly readable.
 */
function blockerSeeds(
	readings: Iterable<EdgeReading>,
	own: ReadonlySet<IssueId>,
): { readonly seeds: readonly GraphSeed[]; readonly contradicted: readonly TicketRef[] } {
	const outside = new Map<IssueId, { readonly ref: TicketRef; readonly open: boolean | "unknown" }>();
	for (const edges of readings) {
		if (typeof edges === "string") continue;
		for (const edge of edges) {
			const id = ticketId(edge.ref);
			if (own.has(id)) continue;
			const seen = outside.get(id);
			outside.set(id, { ref: edge.ref, open: seen === undefined || seen.open === edge.open ? edge.open : "unknown" });
		}
	}

	const seeds: GraphSeed[] = [];
	const contradicted: TicketRef[] = [];
	for (const [id, blocker] of outside) {
		if (blocker.open === "unknown") contradicted.push(blocker.ref);
		// Its own blockers were never read, and saying so is the point: a closed one is pruned before they are
		// consulted, and an open one blocks on its own.
		seeds.push({ id, parent: null, blockers: "unknown", open: blocker.open });
	}
	return { seeds, contradicted };
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
 * a node list that does not match its own count reads `"partial"`, which holds the ticket out of the answer
 * rather than judging it either way. ADR-0027 has why each, and why the empty case is not the unknown one.
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
	// narrower refusal than failing the read and losing every other ticket with it. ADR-0027 has both.
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
// removed before matching rather than tolerated inside the pattern — which keeps the pair taken the one before
// the *final* issue number, where an address holding two would otherwise resolve to the first.
const ADDRESS_TAIL = /[?#].*$|\/+$/;

/**
 * The owner and repository an issue address names, which is where every ref's repository comes from — a row's
 * as much as a blocker's. Both have to be read the same way: a blocker's repository can only come from its
 * address, so taking a row's from the repository the caller asked about instead let one issue occupy two graph
 * nodes. ADR-0027 has what made that silent.
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
