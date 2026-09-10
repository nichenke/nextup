import type { DependencyGraph, IssueId } from "./effective-blockedness";
import type { LabelFilter } from "./label-filter";
import type { Runner } from "./runner";
import { type Selection, select } from "./selector";
import { type Ticket, ticketId } from "./ticket";
import { type TicketRef, formatTicketRef, resolveTicketRef } from "./ticket-ref";
import type { TicketSetRead } from "./ticket-set-read";

export class LiveCheckError extends Error {}

/**
 * One open ticket as an independent query saw it — a different tracker surface, parsed by different code than
 * the adapter's. This is the expected answer the adapter's is measured against, so a field here that came
 * through the adapter would make the comparison a tautology.
 *
 * Nothing is tri-state, unlike `Ticket`: an independent query that could not answer throws rather than
 * degrading, because an expected answer of `"unknown"` disagrees with nothing and would pass while measuring
 * nothing.
 */
export interface LiveObservation {
	readonly ref: TicketRef;
	readonly claimed: boolean;
	readonly labels: readonly string[];
	readonly blockers: readonly LiveObservedBlocker[];
}

export interface LiveObservedBlocker {
	readonly ref: TicketRef;
	readonly open: boolean;
}

/**
 * One tracker's three live reads. The seam issue 26 asks for, so that a second tracker supplies these and
 * inherits every check below rather than writing its own.
 *
 * `observe` is the independent query and the other two go through the adapter under test. `readBlind` asks the
 * same question with the blocking field left out of the projection, which is the only one of the four states
 * issue 26 lists that a healthy repository does not produce on its own — and it is reachable without writing
 * anything, by narrowing what the read asks for.
 */
export interface LiveTracker {
	readonly name: string;
	/** Every open ticket, read independently of the adapter. */
	observe(): readonly LiveObservation[];
	/** The ticket set through the adapter. */
	read(limit: number): TicketSetRead;
	/** The same read with no blocking field in the response at all. */
	readBlind(limit: number): TicketSetRead;
}

export type Verdict = "held" | "failed" | "unexercised";

/**
 * One check's outcome. `detail` is filled in whether the check held or not, because a check that passed
 * without meeting anything is the failure mode this whole harness exists to catch — a pass has to name its
 * evidence.
 *
 * A list rather than one string because a failed check names every ticket it disagreed about, and a real
 * repository produces enough of them that joining them into a line is unreadable — one entry per line is what a
 * report can lay out.
 *
 * `unexercised` is not a pass: it says the repository never produced the state, so the check could not run.
 * Reported that way and counted as a failure by `heldEverywhere`, so pointing this at a repository too simple
 * to exercise a state says so rather than reporting green.
 */
export interface CheckResult {
	readonly name: string;
	readonly verdict: Verdict;
	readonly detail: readonly string[];
}

export interface LiveCheckReport {
	readonly tracker: string;
	readonly checks: readonly CheckResult[];
	/** The frontier the adapter derived, for the report to print beside the verdicts. */
	readonly frontier: readonly TicketRef[];
}

export interface LiveCheckInput {
	readonly read: TicketSetRead;
	readonly blind: TicketSetRead;
	readonly observations: readonly LiveObservation[];
	readonly filter: LabelFilter;
}

/** Whether every check ran and held, which is the whole verdict a caller exits on. */
export function heldEverywhere(report: LiveCheckReport): boolean {
	return report.checks.every((check) => check.verdict === "held");
}

/**
 * Gathers one tracker's reads and checks them.
 *
 * `observe` runs first so its count sizes the adapter read: the comparison is only sound over one window, and
 * asking the adapter for exactly the open tickets an independent query counted is what makes the two the same
 * window. A ticket opened or closed between the two calls shows up as a `whole-set-read` failure rather than as
 * a frontier disagreement, which is why that check comes first in the report.
 *
 * @throws LiveCheckError when the repository has no open tickets, so no state can be exercised.
 */
export function checkLiveTracker(tracker: LiveTracker, filter: LabelFilter): LiveCheckReport {
	const observations = tracker.observe();
	if (observations.length === 0) {
		throw new LiveCheckError(`${tracker.name} answered with no open tickets, so there is nothing for a check to read`);
	}
	const read = tracker.read(observations.length);
	const blind = tracker.readBlind(observations.length);
	const checked = checkLive({ read, blind, observations, filter });
	return { tracker: tracker.name, ...checked };
}

export function checkLive(input: LiveCheckInput): Omit<LiveCheckReport, "tracker"> {
	const selection = select({
		tickets: input.read.tickets,
		graph: input.read.graph,
		truncated: input.read.truncated,
		openOnly: input.read.openOnly,
		filter: input.filter,
	});
	const frontier = frontierOf(selection);
	return {
		frontier,
		checks: [
			wholeSetRead(input),
			referencesParse(input),
			blockersResolve(input),
			countsReconcile(input, selection),
			nothingBlockedIsRecommended(input, selection),
			frontierAgrees(input, selection, frontier),
			claimedLeavesFrontier(input, frontier),
			closedBlockerUnblocksItsDependent(input, frontier),
			blockerOutsideTheSet(input),
			unknownBlockingIsNotAnEmptyList(input),
		],
	};
}

/**
 * The tickets the adapter would recommend from, which is the confirmed-unblocked partition and never the
 * unknown one. `select` ranks only the partition it consulted, so an empty answer here is `counts.unblocked`
 * being zero — `frontierAgrees` asserts that agreement rather than assuming it.
 */
function frontierOf(selection: Selection): readonly TicketRef[] {
	return selection.consulted === "unblocked" ? selection.ranked.map((candidate) => candidate.ref) : [];
}

/**
 * Refuses every command, so that `referencesParse` proves a reference re-parses on its own rather than by
 * asking a tracker what repository it meant.
 */
const NO_RUNNER: Runner = (argv) => {
	throw new Error(`re-parsing a reference asked for ${argv[0] ?? "nothing"}, which it must not need`);
};

/**
 * That the read covers the same window the independent query did, which every comparison below rests on. First
 * in the report because a failure here explains the ones after it.
 */
function wholeSetRead(input: LiveCheckInput): CheckResult {
	const faults: string[] = [];
	if (!input.read.openOnly) faults.push("the read did not ask for open tickets only, so it is a wider set than was observed");
	if (input.read.truncated) faults.push("the read stopped short of the whole ticket set");
	for (const degrade of input.read.degraded) faults.push(`the read degraded: ${degrade.kind}`);
	if (input.read.tickets.length !== input.observations.length) {
		faults.push(`the read returned ${input.read.tickets.length} tickets where ${input.observations.length} were observed open`);
	}
	if (input.blind.tickets.length !== input.read.tickets.length) {
		faults.push(`the blocking-field-less read returned ${input.blind.tickets.length} tickets rather than ${input.read.tickets.length}`);
	}
	return {
		name: "whole-set-read",
		verdict: faults.length === 0 ? "held" : "failed",
		detail:
			faults.length === 0
				? [`${input.read.tickets.length} open tickets, untruncated, nothing degraded, matching the independent count`]
				: faults,
	};
}

/** That every reference the read produced is one this tool's own parser accepts back. */
function referencesParse(input: LiveCheckInput): CheckResult {
	const faults: string[] = [];
	for (const ticket of input.read.tickets) {
		const printed = formatTicketRef(ticket.ref);
		try {
			const parsed = resolveTicketRef(printed, { runner: NO_RUNNER });
			if (ticketId(parsed) !== ticketId(ticket.ref)) {
				faults.push(`${printed} re-parsed as ${ticketId(parsed)} rather than ${ticketId(ticket.ref)}`);
			}
		} catch (cause) {
			faults.push(`${printed} did not re-parse: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}
	return verdictOver("references-parse", input.read.tickets.length, faults, `${input.read.tickets.length} references re-parsed`);
}

/** That no blocking edge names a ticket the read left with no state at all — criterion one's second clause. */
function blockersResolve(input: LiveCheckInput): CheckResult {
	const own = new Set(input.read.tickets.map((ticket) => ticketId(ticket.ref)));
	const contradicted = new Set(refsOfContradictions(input.read).map(ticketId));
	const faults: string[] = [];
	let inSet = 0;
	let outside = 0;
	for (const { ticket, blocker } of edges(input.read.tickets)) {
		const id = ticketId(blocker);
		if (own.has(id)) {
			inSet++;
		} else if (input.read.graph.isOpen(id) !== "unknown" || contradicted.has(id)) {
			outside++;
		} else {
			faults.push(`${formatTicketRef(ticket.ref)} names ${formatTicketRef(blocker)}, which the read left with no state`);
		}
	}
	return verdictOver("blockers-resolve", inSet + outside, faults, `${inSet} blockers inside the set, ${outside} outside it`);
}

/** That every ticket was accounted for exactly once — criterion one's third clause. */
function countsReconcile(input: LiveCheckInput, selection: Selection): CheckResult {
	const counts = selection.counts;
	const closed = counts.closed === "not-asked" ? 0 : counts.closed;
	const faults: string[] = [];
	if (counts.tickets !== input.read.tickets.length) {
		faults.push(`the answer counted ${counts.tickets} tickets where the read returned ${input.read.tickets.length}`);
	}
	const placed = closed + counts.claimed + counts.filtered + counts.candidates;
	if (placed !== counts.tickets) {
		faults.push(`${placed} tickets were placed where ${counts.tickets} were read`);
	}
	const partitioned = counts.unblocked + counts.unknown + counts.blocked;
	if (partitioned !== counts.candidates) {
		faults.push(`${partitioned} candidates were partitioned where ${counts.candidates} were counted`);
	}
	return {
		name: "counts-reconcile",
		verdict: faults.length === 0 ? "held" : "failed",
		detail:
			faults.length === 0
				? [
						`${counts.tickets} tickets: ${counts.claimed} claimed, ${counts.filtered} filtered, ${counts.unblocked} unblocked, ${counts.unknown} unknown, ${counts.blocked} blocked`,
					]
				: faults,
	};
}

/**
 * That nothing the answer offers is a ticket the tracker says is waiting on something — criterion one's fourth
 * clause.
 *
 * Judged against the independent observation rather than against the graph the ranking came from. Asking the
 * same graph twice cannot disagree with itself: `select` derives each candidate's state from it, so a check
 * re-deriving from it restates the answer instead of testing it, and passes however wrong the graph is.
 */
function nothingBlockedIsRecommended(input: LiveCheckInput, selection: Selection): CheckResult {
	const observed = new Map(input.observations.map((one) => [ticketId(one.ref), one] as const));
	const faults: string[] = [];
	for (const candidate of selection.ranked) {
		const one = observed.get(ticketId(candidate.ref));
		if (one === undefined) {
			faults.push(`${formatTicketRef(candidate.ref)} is ranked, and the tracker did not report it among its open tickets`);
			continue;
		}
		const open = one.blockers.filter((blocker) => blocker.open);
		if (open.length > 0) {
			faults.push(
				`${formatTicketRef(candidate.ref)} is ranked, and the tracker says it waits on ${open.map((blocker) => formatTicketRef(blocker.ref)).join(", ")}`,
			);
		}
	}
	const pick = selection.pick;
	const first = selection.ranked[0];
	if ((pick?.ref === undefined ? null : ticketId(pick.ref)) !== (first === undefined ? null : ticketId(first.ref))) {
		faults.push("the pick is not the head of the ranking");
	}
	return verdictOver(
		"nothing-blocked-is-recommended",
		selection.ranked.length,
		faults,
		`${selection.ranked.length} ranked candidates, all ${selection.consulted}`,
	);
}

/**
 * That the frontier the adapter derived is the one the tracker itself reports — criterion two, and the check
 * the other nine exist to make trustworthy.
 *
 * The label filter is shared with the adapter's side on purpose: what is being compared is the read, and the
 * labels each side applies the filter to were read separately, so a misread label still shows up here. A second
 * implementation of the filter would measure the filter instead.
 */
function frontierAgrees(input: LiveCheckInput, selection: Selection, frontier: readonly TicketRef[]): CheckResult {
	const faults: string[] = [];
	// Without this the comparison silently narrows: a ticket the adapter could not judge is in neither set, so a
	// read that degraded on half its tickets would agree with the tracker about the other half and pass.
	if (selection.counts.unknown > 0) {
		faults.push(`${selection.counts.unknown} tickets came back with unknown blocking, so the frontier cannot be compared whole`);
	}
	const expected = new Map(expectedFrontier(input).map((ref) => [ticketId(ref), ref] as const));
	const actual = new Map(frontier.map((ref) => [ticketId(ref), ref] as const));
	for (const [id, ref] of expected) {
		if (!actual.has(id)) faults.push(`${formatTicketRef(ref)} is on the tracker's frontier and not on the adapter's`);
	}
	for (const [id, ref] of actual) {
		if (!expected.has(id)) faults.push(`${formatTicketRef(ref)} is on the adapter's frontier and not on the tracker's`);
	}
	return verdictOver("frontier-agrees", expected.size + actual.size, faults, `${expected.size} tickets, agreed on both sides`);
}

/**
 * The frontier as the independent query alone reports it: open, unclaimed, admitted by the filter, and waiting
 * on nothing that is still open.
 *
 * One hop rather than a traversal, which is the whole reading for a GitHub-shaped tracker: containment is not a
 * blocking channel (ADR-0017), so a ticket's own edges are the only thing that gates it and a blocker's own
 * blockers never enter. A tracker whose containment does gate its children needs its own expected frontier, not
 * this one.
 */
function expectedFrontier(input: LiveCheckInput): readonly TicketRef[] {
	return input.observations
		.filter((one) => !one.claimed && input.filter.admits(one.labels) && one.blockers.every((blocker) => !blocker.open))
		.map((one) => one.ref);
}

/** That a claim takes its ticket off the frontier — the first of the four states criterion three names. */
function claimedLeavesFrontier(input: LiveCheckInput, frontier: readonly TicketRef[]): CheckResult {
	const onFrontier = new Set(frontier.map(ticketId));
	const withheld = input.observations.filter(
		(one) => one.claimed && input.filter.admits(one.labels) && one.blockers.every((blocker) => !blocker.open),
	);
	const faults = withheld
		.filter((one) => onFrontier.has(ticketId(one.ref)))
		.map((one) => `${formatTicketRef(one.ref)} is claimed and is on the frontier anyway`);
	return verdictOver(
		"claimed-leaves-frontier",
		withheld.length,
		faults,
		`${withheld.length} claimed tickets that would otherwise be on the frontier, none of them on it`,
	);
}

/** That a closed blocker stops gating — the second of the four states criterion three names. */
function closedBlockerUnblocksItsDependent(input: LiveCheckInput, frontier: readonly TicketRef[]): CheckResult {
	const onFrontier = new Set(frontier.map(ticketId));
	const admitted = admittedByRef(input);
	const freed = input.read.tickets.filter((ticket) => onlyClosedBlockers(ticket, input.read.graph));
	const faults = freed
		.filter((ticket) => admitted.has(ticketId(ticket.ref)) && !onFrontier.has(ticketId(ticket.ref)))
		.map((ticket) => `${formatTicketRef(ticket.ref)} waits only on closed blockers and is off the frontier`);
	return verdictOver(
		"closed-blocker-unblocks-its-dependent",
		freed.length,
		faults,
		`${freed.length} tickets waiting only on closed blockers, every recommendable one on the frontier`,
	);
}

/** Whether a ticket has blockers and the graph confirms every one of them closed. */
function onlyClosedBlockers(ticket: Ticket, graph: DependencyGraph): boolean {
	if (ticket.blockers === "unknown" || ticket.blockers.length === 0) return false;
	return ticket.blockers.every((blocker) => graph.isOpen(ticketId(blocker)) === false);
}

/**
 * Which read tickets the answer could recommend at all, so that a ticket held off the frontier by a claim or a
 * label is not read as a blocking mistake. Taken from the observations rather than from the tickets, because
 * the claim is one of the things under test and the adapter's copy of it cannot be the judge.
 */
function admittedByRef(input: LiveCheckInput): ReadonlySet<IssueId> {
	const admitted = new Set<IssueId>();
	for (const one of input.observations) {
		if (!one.claimed && input.filter.admits(one.labels)) admitted.add(ticketId(one.ref));
	}
	return admitted;
}

/** That a blocker the read never returned still carries state — the third of the four states criterion three names. */
function blockerOutsideTheSet(input: LiveCheckInput): CheckResult {
	const own = new Set(input.read.tickets.map((ticket) => ticketId(ticket.ref)));
	const outside = new Map<IssueId, TicketRef>();
	for (const { blocker } of edges(input.read.tickets)) {
		const id = ticketId(blocker);
		if (!own.has(id)) outside.set(id, blocker);
	}
	const faults = [...outside.values()]
		.filter((ref) => input.read.graph.isOpen(ticketId(ref)) === "unknown")
		.map((ref) => `${formatTicketRef(ref)} blocks a ticket in the set and the read left it with no state`);
	return verdictOver(
		"blocker-outside-the-set",
		outside.size,
		faults,
		`${outside.size} blockers outside the read, each still carrying the openness its edge named`,
	);
}

/**
 * That an unanswered blocking field reads as unknown rather than as no blockers — the fourth of the four states
 * criterion three names, and the one the collapse `CONTEXT.md` forbids would hide in.
 *
 * Asserted over a read of the same tickets with the field left out of the projection, so this is a live shape
 * rather than a constructed one, and read-only.
 */
function unknownBlockingIsNotAnEmptyList(input: LiveCheckInput): CheckResult {
	const faults: string[] = [];
	const collapsed = input.blind.tickets.filter((ticket) => ticket.blockers !== "unknown");
	for (const ticket of collapsed) {
		const blockers = ticket.blockers;
		const how = blockers === "unknown" ? "unknown" : blockers.length === 0 ? "an empty list" : `${blockers.length} blockers`;
		faults.push(`${formatTicketRef(ticket.ref)} came back with ${how} where the response carried no blocking field`);
	}
	const unreadable = input.blind.degraded.find((degrade) => degrade.kind === "unreadable-blocking");
	if (unreadable === undefined) {
		faults.push("the read did not report unreadable blocking at all");
	} else if (unreadable.tickets !== input.blind.tickets.length || unreadable.of !== input.blind.tickets.length) {
		faults.push(
			`the read reported ${unreadable.tickets} of ${unreadable.of} tickets with unreadable blocking, where all ${input.blind.tickets.length} of them were`,
		);
	}
	const blind = select({
		tickets: input.blind.tickets,
		graph: input.blind.graph,
		truncated: input.blind.truncated,
		openOnly: input.blind.openOnly,
		filter: input.filter,
	});
	// The collapse this check is named for, seen from the answer rather than from the tickets: were an absent
	// field read as an empty list, every candidate would come back confirmed unblocked and be recommended.
	if (blind.counts.unblocked > 0) {
		faults.push(`${blind.counts.unblocked} candidates were called confirmed-unblocked with no blocking field in the response`);
	}
	return verdictOver(
		"unknown-blocking-is-not-an-empty-list",
		input.blind.tickets.length,
		faults,
		`${input.blind.tickets.length} tickets, all unknown, ${blind.counts.unknown} recommendable only as unknown`,
	);
}

/** Every ticket's blocking edges, paired with the ticket that named them. */
function edges(tickets: readonly Ticket[]): readonly { readonly ticket: Ticket; readonly blocker: TicketRef }[] {
	return tickets.flatMap((ticket) =>
		ticket.blockers === "unknown" ? [] : ticket.blockers.map((blocker) => ({ ticket, blocker })),
	);
}

function refsOfContradictions(read: TicketSetRead): readonly TicketRef[] {
	return read.degraded.flatMap((degrade) => (degrade.kind === "contradicted-blocker" ? degrade.refs : []));
}

/**
 * A check's outcome, where meeting nothing is `unexercised` rather than a pass. `observed` is what the check
 * actually looked at, so a check whose subject the repository never produced cannot report that it held.
 */
function verdictOver(name: string, observed: number, faults: readonly string[], detail: string): CheckResult {
	if (faults.length > 0) return { name, verdict: "failed", detail: faults };
	if (observed === 0) return { name, verdict: "unexercised", detail: ["the repository produced nothing for this check to read"] };
	return { name, verdict: "held", detail: [detail] };
}
