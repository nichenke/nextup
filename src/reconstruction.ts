import type { DependencyGraph, IssueId } from "./effective-blockedness";
import type { LabelFilter } from "./label-filter";
import type { NonEmpty } from "./non-empty";
import type { Runner } from "./runner";
import { type Selection, select } from "./selector";
import { type Ticket, ticketId } from "./ticket";
import { type TicketRef, formatTicketRef, resolveTicketRef } from "./ticket-ref";
import type { ReadDegrade, TicketSetRead } from "./ticket-set-read";

export class ReconstructionError extends Error {}

/**
 * One open ticket as an independent query saw it — a different tracker surface, parsed by different code than
 * the adapter's. This is the expected answer the adapter's is measured against, so a field here that came
 * through the adapter would make the comparison a tautology.
 *
 * Nothing is tri-state, unlike `Ticket`: an independent query that could not answer throws rather than
 * degrading, because an expected answer of `"unknown"` disagrees with nothing and would pass while measuring
 * nothing.
 */
export interface TrackerObservation {
	readonly ref: TicketRef;
	readonly claimed: boolean;
	readonly labels: readonly string[];
	readonly blockers: readonly ObservedBlocker[];
}

export interface ObservedBlocker {
	readonly ref: TicketRef;
	readonly open: boolean;
}

/**
 * One tracker's three reads. The seam issue 26 asks for, so that a second tracker supplies these and
 * inherits every check below rather than writing its own.
 *
 * `readBlind` covers the only one of the four states issue 26 lists that a healthy repository does not produce on
 * its own, and it is reachable without writing anything — by narrowing what the read asks for.
 */
export interface ReconstructionTracker {
	readonly name: string;
	/** Every open ticket, read independently of the adapter. */
	observe(): readonly TrackerObservation[];
	/** The ticket set through the adapter. */
	read(limit: number): TicketSetRead;
	/** The same read with no blocking field in the response at all. */
	readBlind(limit: number): TicketSetRead;
}

/** `unexercised` — the check met nothing — is not a pass, and `heldEverywhere` counts it with the failures. */
export type Verdict = "held" | "failed" | "unexercised";

/**
 * One check's outcome. `detail` is non-empty whether the check held or not: a pass has to name its evidence.
 * A list rather than one string because a failed check names every ticket it disagreed about, and a real
 * repository supplies more of them than a single line can carry.
 */
export interface CheckResult {
	readonly name: string;
	readonly verdict: Verdict;
	readonly detail: NonEmpty<string>;
}

export interface ReconstructionReport {
	readonly tracker: string;
	readonly checks: readonly CheckResult[];
	/** The frontier the adapter derived, for the report to print beside the verdicts. */
	readonly frontier: readonly TicketRef[];
}

export interface ReconstructionInput {
	readonly read: TicketSetRead;
	readonly blind: TicketSetRead;
	readonly observations: readonly TrackerObservation[];
	readonly filter: LabelFilter;
}

/** Whether every check ran and held, which is the whole verdict a caller exits on. */
export function heldEverywhere(report: ReconstructionReport): boolean {
	return report.checks.every((check) => check.verdict === "held");
}

/**
 * Gathers one tracker's reads and checks them.
 *
 * `observe` runs first so its count sizes the adapter read: the comparison is only sound over one window, and
 * asking the adapter for exactly the open tickets an independent query counted is what makes the two the same
 * window.
 *
 * Three live reads, so three windows, not two: `read` and `readBlind` each issue their own list call, and a
 * ticket opened or closed between any adjacent pair fails `whole-set-read`, possibly alongside a frontier
 * disagreement it caused.
 *
 * @throws ReconstructionError when the repository has no open tickets, so no state can be exercised.
 */
export function checkReconstructionTracker(tracker: ReconstructionTracker, filter: LabelFilter): ReconstructionReport {
	const observations = tracker.observe();
	if (observations.length === 0) {
		throw new ReconstructionError(`${tracker.name} answered with no open tickets, so there is nothing for a check to read`);
	}
	const read = tracker.read(observations.length);
	const blind = tracker.readBlind(observations.length);
	const checked = checkReconstruction({ read, blind, observations, filter });
	return { tracker: tracker.name, ...checked };
}

export function checkReconstruction(input: ReconstructionInput): Omit<ReconstructionReport, "tracker"> {
	const selection = answerFor(input.read, input.filter);
	const frontier = frontierOf(selection);
	return {
		frontier,
		checks: [
			wholeSetRead(input),
			referencesParse(input),
			blockersResolve(input),
			countsReconcile(input, selection),
			nothingBlockedIsRecommended(input, selection),
			edgesAgree(input),
			frontierAgrees(input, selection, frontier),
			claimedLeavesFrontier(input, frontier),
			closedBlockerUnblocksItsDependent(input, frontier),
			blockerOutsideTheSet(input),
			unknownBlockingIsNotAnEmptyList(input),
		],
	};
}

/** The answer the command itself would give for one read, which is what every check below is about. */
function answerFor(read: TicketSetRead, filter: LabelFilter): Selection {
	return { ...select({ tickets: read.tickets, graph: read.graph, truncated: read.truncated, openOnly: read.openOnly, filter }) };
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
 * Whether a degrade says anything about the window `wholeSetRead` is comparing. An outage is the call itself
 * failing, so there is no window at all; the rest are the tracker answering with less than one answer in it,
 * which `TicketSetRead.degraded` holds apart from a defect — and `contradicted-blocker` is the one to expect on a
 * healthy adapter, exempted by name in the three checks that consult a blocker's openness (ADR-0027). Faulting on
 * every kind reported a healthy read as a disagreement about the window, which is how a real one gets waved
 * through.
 *
 * Nothing goes unnoticed for being false here: unreadable blocking leaves `frontierAgrees` unable to compare, and
 * a withheld ticket keeps its place in the expected frontier, so one that should be recommended still disagrees
 * there.
 *
 * A `Record` rather than a test on one kind, following `tally` in `selector.ts`: a kind added to `ReadDegrade`
 * without a decision here fails to compile, instead of joining the quiet side by default.
 */
const DEGRADE_IS_THIS_CHECKS_BUSINESS: Record<ReadDegrade["kind"], boolean> = {
	outage: true,
	"unreadable-blocking": false,
	"partial-blocking": false,
	"contradicted-blocker": false,
};

/**
 * That the read covers the same window the independent query did, which every comparison below rests on. First
 * in the report because a failure here explains the ones after it.
 *
 * Membership on each side rather than a count of it: two sides holding different tickets balance whenever the
 * same number entered as left, and then nothing below can see it — `edgesAgree` skips a read ticket the tracker
 * never observed, and a ticket only the tracker saw reaches no check unless it is frontier-worthy there, which a
 * claimed or filtered one is not. ADR-0033 rests the independent
 * reader's want of a fixture on this check seeing a dropped or invented ticket, which only the sets do.
 */
function wholeSetRead(input: ReconstructionInput): CheckResult {
	const faults: string[] = [];
	if (!input.read.openOnly) faults.push("the read did not ask for open tickets only, so it is a wider set than was observed");
	if (input.read.truncated) faults.push("the read stopped short of the whole ticket set");
	// Asked of the blind read too, which the membership comparison below cannot answer for: a read truncated back to
	// the same tickets matches on membership while having looked at a wider set than the other two did. Reachable
	// without a defect — a ticket opened between the two adapter reads, sorting after the ones already asked for.
	if (input.blind.truncated) faults.push("the blocking-field-less read stopped short of the whole ticket set");
	for (const degrade of input.read.degraded) {
		if (!DEGRADE_IS_THIS_CHECKS_BUSINESS[degrade.kind]) continue;
		faults.push(degrade.kind === "outage" ? `the read did not complete: ${degrade.detail}` : `the read degraded: ${degrade.kind}`);
	}
	const met = metByRead(input.read);
	const observed = refsById(input.observations.map((one) => one.ref));
	const blind = refsById(input.blind.tickets.map((ticket) => ticket.ref));
	for (const ref of onlyIn(observed, met)) faults.push(`${formatTicketRef(ref)} was observed open and the read did not return it`);
	for (const ref of onlyIn(met, observed)) faults.push(`the read returned ${formatTicketRef(ref)}, which was not observed open`);
	for (const ref of onlyIn(met, blind)) faults.push(`the blocking-field-less read did not return ${formatTicketRef(ref)}`);
	for (const ref of onlyIn(blind, met)) faults.push(`the blocking-field-less read returned ${formatTicketRef(ref)}, which the read did not meet`);
	const kinds = input.read.degraded.map((degrade) => degrade.kind);
	return verdictOver(
		"whole-set-read",
		met.size,
		faults,
		`${met.size} open tickets, untruncated, ${kinds.length === 0 ? "nothing degraded" : `degraded: ${kinds.join(", ")}`}, the same set the tracker observed`,
	);
}

/** That every reference the read produced is one this tool's own parser accepts back. */
function referencesParse(input: ReconstructionInput): CheckResult {
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
function blockersResolve(input: ReconstructionInput): CheckResult {
	const own = new Set(input.read.tickets.map((ticket) => ticketId(ticket.ref)));
	const contradicted = contradictedIds(input.read);
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

/**
 * That every ticket was accounted for exactly once, and under the placement the tracker's own reading of it calls
 * for — criterion one's third clause.
 *
 * Reconciled against the observations rather than within the answer. `select` is handed `read.tickets` and
 * `tally` counts one placement per ticket from a `Record` over the kinds, so the totals hold by construction —
 * asserting them against each other cannot fail, however wrong the claims and labels underneath were read.
 * `nothingBlockedIsRecommended` gives the same reason for judging blocking from the independent side.
 *
 * The order `place` decides in is mirrored here, claim before label, so a claimed ticket the filter would also
 * reject is counted once and on the same side of the split.
 */
function countsReconcile(input: ReconstructionInput, selection: Selection): CheckResult {
	const counts = selection.counts;
	// So a ticket held out for paging blockers is absent from both sides here rather than counted only on the
	// tracker's.
	const answered = answeredOver(input.read);
	const observed = input.observations.filter((one) => answered.has(ticketId(one.ref)));
	const claimed = observed.filter((one) => one.claimed);
	const filtered = observed.filter((one) => !one.claimed && !input.filter.admits(one.labels));
	const candidates = observed.length - claimed.length - filtered.length;
	const faults: string[] = [];
	if (counts.claimed !== claimed.length) {
		faults.push(`the answer counted ${counts.claimed} tickets claimed where the tracker reports ${claimed.length} of them claimed`);
	}
	if (counts.filtered !== filtered.length) {
		faults.push(`the answer held ${counts.filtered} tickets back by label where the tracker's own labels call for ${filtered.length}`);
	}
	if (counts.candidates !== candidates) {
		faults.push(`the answer counted ${counts.candidates} candidates where the tracker's tickets leave ${candidates}`);
	}
	return verdictOver(
		"counts-reconcile",
		observed.length,
		faults,
		`${observed.length} tickets: ${counts.claimed} claimed, ${counts.filtered} filtered, ${counts.unblocked} unblocked, ${counts.unknown} unknown, ${counts.blocked} blocked, each placed as the tracker reads it`,
	);
}

/**
 * That nothing the answer offers is a ticket the tracker says is waiting on something — criterion one's fourth
 * clause.
 *
 * Judged against the independent observation rather than against the graph the ranking came from. Asking the
 * same graph twice cannot disagree with itself: `select` derives each candidate's state from it, so a check
 * re-deriving from it restates the answer instead of testing it, and passes however wrong the graph is.
 */
function nothingBlockedIsRecommended(input: ReconstructionInput, selection: Selection): CheckResult {
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
	return verdictOver(
		"nothing-blocked-is-recommended",
		selection.ranked.length,
		faults,
		`${selection.ranked.length} ranked candidates, all ${selection.consulted}`,
	);
}

/**
 * That the two sides read the same blocking edges, and not merely that they arrived at the same frontier.
 *
 * Every other check compares an outcome. An edge that both sides lost produces the same frontier on both, so
 * they agree and nothing above can see it — code independence makes the two unlikely to be wrong in the same
 * way, but it does not make their *data* independent, and only comparing the inputs closes that. ADR-0033 has
 * the reasoning and what remains open.
 *
 * A ticket whose blocking the adapter could not read is skipped rather than faulted: that is
 * `unknown-blocking-is-not-an-empty-list`'s subject, and a ticket missing from one side entirely is
 * `wholeSetRead`'s.
 */
function edgesAgree(input: ReconstructionInput): CheckResult {
	const observed = new Map(input.observations.map((one) => [ticketId(one.ref), one] as const));
	const contradicted = contradictedIds(input.read);
	const faults: string[] = [];
	let compared = 0;
	for (const ticket of input.read.tickets) {
		if (ticket.blockers === "unknown") continue;
		const one = observed.get(ticketId(ticket.ref));
		if (one === undefined) continue;
		const readEdges = new Map(ticket.blockers.map((blocker) => [ticketId(blocker), blocker] as const));
		const observedEdges = new Map(one.blockers.map((blocker) => [ticketId(blocker.ref), blocker] as const));
		const named = formatTicketRef(ticket.ref);
		for (const [id, blocker] of readEdges) {
			const edge = observedEdges.get(id);
			if (edge === undefined) {
				faults.push(`the read says ${named} is blocked by ${formatTicketRef(blocker)} and the tracker does not`);
				continue;
			}
			const openness = input.read.graph.isOpen(id);
			if (openness !== edge.open && !contradicted.has(id)) {
				faults.push(`${named}'s blocker ${formatTicketRef(blocker)} is ${openness === "unknown" ? "unknown" : openness ? "open" : "closed"} to the read and ${edge.open ? "open" : "closed"} to the tracker`);
			}
		}
		for (const [id, edge] of observedEdges) {
			if (!readEdges.has(id)) faults.push(`the tracker says ${named} is blocked by ${formatTicketRef(edge.ref)} and the read does not`);
		}
		// The union, not the two sizes added: an edge both sides named is one edge compared, and counting it twice
		// inflates the very number a reader uses to judge whether the pass was vacuous.
		compared += new Set([...readEdges.keys(), ...observedEdges.keys()]).size;
	}
	return verdictOver("edges-agree", compared, faults, `${compared} edges, agreed on both sides`);
}

/**
 * That the frontier the adapter derived is the one the tracker itself reports — criterion two, and the check
 * the other nine exist to make trustworthy.
 *
 * The label filter is shared with the adapter's side on purpose, and the label *values* it decides over are read
 * separately — so a misread of a label the filter turns on still surfaces here. ADR-0033 has why reimplementing
 * the filter would measure the filter instead.
 */
function frontierAgrees(input: ReconstructionInput, selection: Selection, frontier: readonly TicketRef[]): CheckResult {
	const expected = refsById(expectedFrontier(input));
	const actual = refsById(frontier);
	const faults: string[] = [];
	for (const ref of onlyIn(expected, actual)) faults.push(`${formatTicketRef(ref)} is on the tracker's frontier and not on the adapter's`);
	for (const ref of onlyIn(actual, expected)) faults.push(`${formatTicketRef(ref)} is on the adapter's frontier and not on the tracker's`);
	// The union, for the reason `edgesAgree` gives: a ticket on both frontiers is one ticket compared.
	const compared = new Set([...expected.keys(), ...actual.keys()]).size;
	// An unknown ticket the tracker also excludes — claimed, filtered, or open-blocked there — is on neither
	// frontier, so that half of a degraded read agrees by construction, and the comparison is refused rather than
	// reported as an agreement it did not test. The other half faults on its own, since `observe` carries no
	// unknown and puts such a ticket on the tracker's frontier.
	//
	// `unexercised` rather than a fault of its own, because declining to compare is not a disagreement: both exit
	// non-zero, and a fault here reads as the two frontiers differing, which is the first thing the reader would
	// go and investigate.
	if (selection.counts.unknown > 0) {
		const partial = `${selection.counts.unknown} tickets came back with unknown blocking, so the frontier cannot be compared whole`;
		if (faults.length === 0) return { name: "frontier-agrees", verdict: "unexercised", detail: [partial] };
		faults.push(partial);
	}
	return verdictOver("frontier-agrees", compared, faults, `${compared} tickets, agreed on both sides`);
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
function expectedFrontier(input: ReconstructionInput): readonly TicketRef[] {
	return input.observations.filter((one) => frontierWorthy(one, input) && !one.claimed).map((one) => one.ref);
}

/**
 * Whether the tracker says this ticket belongs on the frontier but for its claim — admitted by the filter and
 * waiting on nothing still open. One predicate because `expectedFrontier` and `claimedLeavesFrontier` are the two
 * halves of it, and a claim moving a ticket between them is the thing they exist to check.
 */
function frontierWorthy(one: TrackerObservation, input: ReconstructionInput): boolean {
	return input.filter.admits(one.labels) && one.blockers.every((blocker) => !blocker.open);
}

/** That a claim takes its ticket off the frontier — the first of the four states criterion three names. */
function claimedLeavesFrontier(input: ReconstructionInput, frontier: readonly TicketRef[]): CheckResult {
	const onFrontier = new Set(frontier.map(ticketId));
	const answered = answeredOver(input.read);
	// `answeredOver` and not `metByRead`, which `wholeSetRead` above uses for the opposite reason: a ticket the read
	// withheld was met, but the answer never placed it, so it is off the frontier for that reason alone and
	// counting it exercised reports the claim as the cause of an absence it did not produce.
	const withheld = input.observations.filter(
		(one) => frontierWorthy(one, input) && one.claimed && answered.has(ticketId(one.ref)),
	);
	const faults = withheld
		.filter((one) => onFrontier.has(ticketId(one.ref)))
		.map((one) => `${formatTicketRef(one.ref)} is claimed and is on the frontier anyway`);
	// An empty frontier makes the absence of these tickets from it prove nothing, whatever emptied it — so the
	// exercised count needs a frontier to have been kept off, not just a claimed ticket to have existed.
	return verdictOver(
		"claimed-leaves-frontier",
		onFrontier.size === 0 ? 0 : withheld.length,
		faults,
		`${withheld.length} claimed tickets kept off a frontier of ${onFrontier.size}`,
	);
}

/** That a closed blocker stops gating — the second of the four states criterion three names. */
function closedBlockerUnblocksItsDependent(input: ReconstructionInput, frontier: readonly TicketRef[]): CheckResult {
	const onFrontier = new Set(frontier.map(ticketId));
	const admitted = admittedByRef(input);
	// Narrowed before the count, not after: a ticket held off the frontier by a claim or a label proves nothing
	// either way, so counting it as exercised reports evidence for a comparison that never happened. On a
	// repository where the claimed tickets are the ones with closed blockers, that is a `held` over nothing.
	const tested = input.read.tickets.filter(
		(ticket) => onlyClosedBlockers(ticket, input.read.graph) && admitted.has(ticketId(ticket.ref)),
	);
	const faults = tested
		.filter((ticket) => !onFrontier.has(ticketId(ticket.ref)))
		.map((ticket) => `${formatTicketRef(ticket.ref)} waits only on closed blockers and is off the frontier`);
	return verdictOver(
		"closed-blocker-unblocks-its-dependent",
		tested.length,
		faults,
		`${tested.length} recommendable tickets waiting only on closed blockers, every one of them on the frontier`,
	);
}

/** Whether a ticket has blockers and the graph confirms every one of them closed. */
function onlyClosedBlockers(ticket: Ticket, graph: DependencyGraph): boolean {
	if (ticket.blockers === "unknown" || ticket.blockers.length === 0) return false;
	return ticket.blockers.every((blocker) => graph.isOpen(ticketId(blocker)) === false);
}

/**
 * Which tickets the answer could recommend at all, so that one held off the frontier by a claim or a label is not
 * read as a blocking mistake. Taken from the observations rather than from `read.tickets`, because the claim is one
 * of the things under test and the adapter's copy of it cannot be the judge.
 */
function admittedByRef(input: ReconstructionInput): ReadonlySet<IssueId> {
	const admitted = new Set<IssueId>();
	for (const one of input.observations) {
		if (!one.claimed && input.filter.admits(one.labels)) admitted.add(ticketId(one.ref));
	}
	return admitted;
}

/**
 * That the read met a blocker it did not return as a ticket — the third of the four states criterion three names.
 *
 * Coverage only, with no fault of its own: whether such a blocker carries a state is `blockersResolve`'s
 * assertion over every edge, and a second copy of that predicate here reported the same defect twice and had to
 * be kept in step for no gain.
 */
function blockerOutsideTheSet(input: ReconstructionInput): CheckResult {
	const own = new Set(input.read.tickets.map((ticket) => ticketId(ticket.ref)));
	const outside = new Map<IssueId, TicketRef>();
	for (const { blocker } of edges(input.read.tickets)) {
		const id = ticketId(blocker);
		if (!own.has(id)) outside.set(id, blocker);
	}
	return verdictOver("blocker-outside-the-set", outside.size, [], `${outside.size} blockers outside the read`);
}

/**
 * That an unanswered blocking field reads as unknown rather than as no blockers — the fourth of the four states
 * criterion three names, and the one the collapse `CONTEXT.md` forbids would hide in.
 *
 * Asserted over a read of the same tickets with the field left out of the projection, so this is a real shape
 * rather than a constructed one, and read-only.
 */
function unknownBlockingIsNotAnEmptyList(input: ReconstructionInput): CheckResult {
	const faults: string[] = [];
	for (const ticket of input.blind.tickets) {
		const blockers = ticket.blockers;
		if (blockers === "unknown") continue;
		const how = blockers.length === 0 ? "an empty list" : `${blockers.length} blockers`;
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
	const blind = answerFor(input.blind, input.filter);
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

/** Every blocking edge, paired with the ticket that named it. A ticket whose blocking is unknown contributes none. */
function edges(tickets: readonly Ticket[]): readonly { readonly ticket: Ticket; readonly blocker: TicketRef }[] {
	return tickets.flatMap((ticket) =>
		ticket.blockers === "unknown" ? [] : ticket.blockers.map((blocker) => ({ ticket, blocker })),
	);
}

function refsById(refs: readonly TicketRef[]): ReadonlyMap<IssueId, TicketRef> {
	return new Map(refs.map((ref) => [ticketId(ref), ref] as const));
}

/** The references on the left that the right does not hold, which is how three checks name a side's own surplus. */
function onlyIn(left: ReadonlyMap<IssueId, TicketRef>, right: ReadonlyMap<IssueId, TicketRef>): readonly TicketRef[] {
	return [...left].filter(([id]) => !right.has(id)).map(([, ref]) => ref);
}

/**
 * The tickets that reached `select`, which is narrower than `metByRead` by every ticket the read withheld. A check
 * asking what the answer did with a ticket has to use this one: a withheld ticket is not in the answer, so the
 * answer cannot have placed it anywhere for the reason under test.
 */
function answeredOver(read: TicketSetRead): ReadonlyMap<IssueId, TicketRef> {
	return refsById(read.tickets.map((ticket) => ticket.ref));
}

/**
 * Every ticket the read met, which includes the ones it withheld for arriving with only a page of their blockers.
 *
 * Those rows were read and held out of the answer deliberately (ADR-0027), so counting them unread would report
 * one paging degrade as tickets missing from the read as well — and as missing from the blind read in the
 * opposite direction, since a response with no blocking field at all has no short node list to hold anything out
 * and returns them. The degrade itself faults, once.
 */
function metByRead(read: TicketSetRead): ReadonlyMap<IssueId, TicketRef> {
	const withheld = read.degraded.flatMap((degrade) => (degrade.kind === "partial-blocking" ? degrade.refs : []));
	return refsById([...read.tickets.map((ticket) => ticket.ref), ...withheld]);
}

/**
 * The blockers the read reported as contradicted, which every check consulting a blocker's openness has to exempt:
 * the adapter seeds one `"unknown"` deliberately (ADR-0027), so it is a state the read reported rather than one it
 * failed to. Written once because it is three sites, and the third was missed when it was written twice.
 */
function contradictedIds(read: TicketSetRead): ReadonlySet<IssueId> {
	return new Set(read.degraded.flatMap((degrade) => (degrade.kind === "contradicted-blocker" ? degrade.refs : [])).map(ticketId));
}

/**
 * A check's outcome, where meeting nothing is `unexercised` rather than a pass. `observed` is what the check
 * actually looked at, so a check whose subject the repository never produced cannot report that it held.
 *
 * A fault outranks meeting nothing, so a check can be `failed` having observed zero — which is what
 * `unknownBlockingIsNotAnEmptyList` reports when the read named no degrade at all.
 */
function verdictOver(name: string, observed: number, faults: readonly string[], detail: string): CheckResult {
	const [first, ...rest] = faults;
	if (first !== undefined) return { name, verdict: "failed", detail: [first, ...rest] };
	if (observed === 0) return { name, verdict: "unexercised", detail: ["the repository produced nothing for this check to read"] };
	return { name, verdict: "held", detail: [detail] };
}
