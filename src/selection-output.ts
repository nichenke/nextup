import type { LabelFilterSpec } from "./label-filter";
import { type NonEmpty, mapNonEmpty } from "./non-empty";
import type { Candidate, Deadlock, Degrade, Rung, Selection, SelectionCounts } from "./selector";
import { type TicketRef, formatTicketRef } from "./ticket-ref";
import type { ReadDegrade } from "./ticket-set-read";

/**
 * The prefix a degraded answer's every reason line carries, so that a caller can test for a degrade
 * with `grep '^degraded: '` rather than by matching the prose after it. The prose is free to change;
 * this is the contract.
 */
export const DEGRADED_PREFIX = "degraded: ";

/** Greppable like `DEGRADED_PREFIX`, and stable for the same reason: the prose after it is free to change. */
export const DEADLOCK_PREFIX = "deadlock: ";

/**
 * The JSON forms are their source types with only the fields that change shape restated. Spelling them
 * out in full would let a field added to `Candidate` or `Selection` reach neither the type nor the
 * output: `--json` would simply not carry it, and nothing would fail.
 */
export type CandidateJson = Omit<Candidate, "ref"> & { readonly ref: string };

export type DecisionJson =
	| { readonly kind: "only-candidate" }
	| { readonly kind: "rung"; readonly rung: Rung; readonly over: string };

export type DeadlockJson = Omit<Deadlock, "cycle"> & { readonly cycle: NonEmpty<string> };

export type SelectionJson = Omit<Selection, "pick" | "decision" | "ranked" | "deadlocks" | "degraded"> & {
	readonly pick: CandidateJson | null;
	readonly decision: DecisionJson | null;
	readonly ranked: readonly CandidateJson[];
	readonly deadlocks: readonly DeadlockJson[];
	readonly degraded: readonly Degrade["kind"][];
};

/**
 * The selection as plain JSON. Every reference becomes its short form, and an absent pick is an
 * explicit `null` rather than a missing key — a consumer reading `.pick` needs the two to be the same
 * shape, and `undefined` would drop the key entirely on the way through `JSON.stringify`.
 */
export function selectionJson(selection: Selection): SelectionJson {
	return {
		...selection,
		pick: selection.pick === null ? null : candidateJson(selection.pick),
		decision:
			selection.decision === null
				? null
				: selection.decision.kind === "only-candidate"
					? { kind: "only-candidate" }
					: { kind: "rung", rung: selection.decision.rung, over: formatTicketRef(selection.decision.over) },
		ranked: selection.ranked.map(candidateJson),
		deadlocks: selection.deadlocks.map(deadlockJson),
		degraded: selection.degraded.map((degrade) => degrade.kind),
	};
}

function candidateJson(candidate: Candidate): CandidateJson {
	return { ...candidate, ref: formatTicketRef(candidate.ref) };
}

function deadlockJson(deadlock: Deadlock): DeadlockJson {
	return { ...deadlock, cycle: mapNonEmpty(deadlock.cycle, formatTicketRef) };
}

/**
 * One run's whole answer. The two degrade lists stay apart because `Degrade` is a conclusion about the
 * ticket set and `ReadDegrade` a fact about the read that produced it.
 */
export interface Answer {
	readonly selection: Selection;
	readonly readDegraded: readonly ReadDegrade[];
}

/**
 * `ReadDegrade` with every reference in its short form, which is how `CandidateJson` carries one too.
 *
 * Each kind is named rather than matched on carrying a `refs` field. Keyed on the field name, a kind added
 * later with a reference under any other name — `ref`, or a `root` beside its `refs` — fell through
 * unconverted and put a raw `{tracker, repo, host, key}` in the output, with no type error and no failing
 * fixture. Named, a new kind is absent from this union instead, and `readDegradeJson` stops compiling.
 */
export type ReadDegradeJson =
	| Extract<ReadDegrade, { readonly kind: "outage" | "unreadable-blocking" }>
	| ShortRefs<"partial-blocking">
	| ShortRefs<"contradicted-blocker">;

/** One kind's JSON form, its own fields carried over so that a field added to it reaches the output. */
type ShortRefs<K extends ReadDegrade["kind"]> = Omit<Extract<ReadDegrade, { readonly kind: K }>, "refs"> & {
	readonly refs: readonly string[];
};

export interface AnswerJson {
	readonly selection: SelectionJson;
	readonly readDegraded: readonly ReadDegradeJson[];
}

export function answerJson(answer: Answer): AnswerJson {
	return { selection: selectionJson(answer.selection), readDegraded: answer.readDegraded.map(readDegradeJson) };
}

function readDegradeJson(degrade: ReadDegrade): ReadDegradeJson {
	switch (degrade.kind) {
		case "outage":
		case "unreadable-blocking":
			return degrade;
		case "partial-blocking":
		case "contradicted-blocker":
			return { ...degrade, refs: degrade.refs.map(formatTicketRef) };
	}
}

export function renderAnswer(answer: Answer): string {
	const read = answer.readDegraded.map((degrade) => `${degradedLine(readDegradeReason(degrade))}\n`);
	return `${renderSelection(answer.selection)}${read.join("")}`;
}

/**
 * One reason line. Whitespace inside the reason is collapsed because a reason can carry a tracker's own
 * message and `gh` writes those over several lines: left alone, the second line reaches the caller with no
 * prefix on it, which is the one thing `DEGRADED_PREFIX` promises cannot happen.
 */
function degradedLine(reason: string): string {
	return `${DEGRADED_PREFIX}${reason.replace(/\s+/g, " ").trim()}`;
}

/**
 * One deadlock as a chain closing on the ticket it started from, so a reader can open each ticket in the
 * tracker, find the next one on it, and arrive back where they began. The first reference is repeated at
 * the end for that reason: a list would leave the last edge, the one that makes it a loop, unstated.
 */
function deadlockLine(deadlock: Deadlock): string {
	const chain = refList([...deadlock.cycle, deadlock.cycle[0]], " blocked by ");
	return `${DEADLOCK_PREFIX}${chain}, so nothing in it can ever unblock`;
}

const DEGRADE_REASON: Record<Degrade["kind"], string> = {
	truncated: "the ticket set was truncated, so a better candidate may not have been read",
	"unknown-blocking": "no candidate's blockers could be confirmed closed, so this pick may be blocked",
};

/**
 * `DEGRADE_REASON`'s sibling for the kinds a read reports, which `ticket-set-read.ts` leaves as kinds for
 * exactly this boundary to word.
 */
function readDegradeReason(degrade: ReadDegrade): string {
	switch (degrade.kind) {
		case "outage":
			return `the ticket set could not be read, so nothing was considered: ${degrade.detail}`;
		case "unreadable-blocking":
			// "of the rows read" rather than "of tickets", which the counts line above uses for a narrower
			// population: a ticket held back for partial blocking is a row that was read and is not a ticket.
			return `${degrade.tickets} of ${degrade.of} rows read did not report their blockers, so nothing confirms them unblocked`;
		case "partial-blocking":
			return `held out of the answer, because only a page of their blockers arrived: ${refList(degrade.refs)}`;
		case "contradicted-blocker":
			return `read as unknown blockers, because the edges naming them disagreed about their state: ${refList(degrade.refs)}`;
	}
}

function refList(refs: readonly TicketRef[], separator = ", "): string {
	return refs.map(formatTicketRef).join(separator);
}

export function renderSelection(selection: Selection): string {
	const lines: string[] = [];

	if (selection.pick === null) {
		lines.push("no candidate to recommend");
	} else {
		lines.push(`${formatTicketRef(selection.pick.ref)} — ${selection.pick.title}`);
		if (selection.pick.url !== null) lines.push(`  ${selection.pick.url}`);
		lines.push(`  ${renderDecision(selection)}`);
		lines.push(`  ${renderSignals(selection.pick)}`);
	}

	lines.push("");
	lines.push(renderCounts(selection.counts, selection.filter));
	for (const deadlock of selection.deadlocks) lines.push(deadlockLine(deadlock));
	for (const degrade of selection.degraded) lines.push(degradedLine(DEGRADE_REASON[degrade.kind]));

	return `${lines.join("\n")}\n`;
}

/**
 * A lone candidate is only lone among the ones the ladder ranked. Saying "the only candidate" while the
 * counts line below reports more of them contradicts it, and the rest are held back rather than absent
 * — blocked, or in the partition that was never consulted.
 */
function renderDecision(selection: Selection): string {
	const decision = selection.decision;
	if (decision !== null && decision.kind === "rung") {
		return `won on ${decision.rung} over ${formatTicketRef(decision.over)}`;
	}
	return heldBackCount(selection) === 0 ? "the only candidate" : "the only candidate the ladder ranked";
}

/** Candidates the ranking never saw: every candidate not in `ranked`, whatever held it back. */
function heldBackCount(selection: Selection): number {
	return selection.counts.candidates - selection.ranked.length;
}

function renderSignals(candidate: Candidate): string {
	// Not "blocking confirmed", the only string here a reader could take to mean confirmed *blocked* —
	// on the line recommending the ticket, above a counts line that says how many are.
	const blocking = candidate.blocked === "unblocked" ? "blockers confirmed closed" : "blockers unknown";
	return `${renderPriority(candidate)}, unblocks ${candidate.unblocks}, ${blocking}`;
}

/**
 * The rank the ladder read, and separately every priority label it could not. A candidate can carry
 * both — a `P1` alongside a `priority:high` — so the unread labels are appended rather than reported
 * only when the rank is absent, which is what ADR-0011 means by naming them against the candidate that
 * carried them.
 */
function renderPriority(candidate: Candidate): string {
	const rank = candidate.priority === null ? "priority none" : `priority P${candidate.priority}`;
	if (candidate.unreadPriority.length === 0) return rank;
	return `${rank} (unread: ${candidate.unreadPriority.join(", ")})`;
}

function renderCounts(counts: SelectionCounts, filter: LabelFilterSpec): string {
	const aside = [
		counts.closed === "not-asked" ? "closed not asked" : `${counts.closed} closed`,
		`${counts.claimed} claimed`,
		`${counts.filtered} filtered out${renderFilter(filter)}`,
		`${counts.candidates} candidates (${counts.unblocked} unblocked, ${counts.unknown} unknown, ${counts.blocked} blocked)`,
	];
	return `${counts.tickets} tickets: ${aside.join(", ")}`;
}

/**
 * The whole filter that did the filtering, beside the count of what it dropped. A count alone leaves a user
 * whose ticket is missing with nothing to look up, and the exclusions are a floor a flag never mentioned.
 *
 * Both halves, because `counts.filtered` is one number over two causes: a ticket carrying an excluded label and
 * a ticket lacking an included one are both filtered. Naming only the exclusions blamed a pattern that had
 * nothing to do with a ticket dropped by `--include`. Printed whether or not anything was dropped, so the line
 * keeps one shape.
 */
function renderFilter(filter: LabelFilterSpec): string {
	const halves: string[] = [];
	if (filter.include.length > 0) halves.push(`including ${filter.include.join(", ")}`);
	if (filter.exclude.length > 0) halves.push(`excluding ${filter.exclude.join(", ")}`);
	return halves.length === 0 ? "" : ` (${halves.join("; ")})`;
}
