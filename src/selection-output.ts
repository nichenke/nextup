import type { LabelFilterSpec } from "./label-filter";
import type { Candidate, Degrade, Rung, Selection, SelectionCounts } from "./selector";
import { formatTicketRef } from "./ticket-ref";

/**
 * The prefix a degraded answer's every reason line carries, so that a caller can test for a degrade
 * with `grep '^degraded: '` rather than by matching the prose after it. The prose is free to change;
 * this is the contract.
 */
export const DEGRADED_PREFIX = "degraded: ";

export interface CandidateJson {
	readonly ref: string;
	readonly title: string;
	readonly url: string | null;
	readonly labels: readonly string[];
	readonly blocked: "unblocked" | "unknown";
	readonly priority: number | null;
	readonly unreadPriority: readonly string[];
	readonly unblocks: number;
}

export type DecisionJson =
	| { readonly kind: "only-candidate" }
	| { readonly kind: "rung"; readonly rung: Rung; readonly over: string };

export interface SelectionJson {
	readonly pick: CandidateJson | null;
	readonly decision: DecisionJson | null;
	readonly consulted: "confirmed" | "unknown" | null;
	readonly ranked: readonly CandidateJson[];
	readonly counts: SelectionCounts;
	readonly degraded: readonly Degrade["kind"][];
	readonly unreadPrioritySignals: readonly string[];
	readonly filter: LabelFilterSpec;
}

/**
 * The selection as plain JSON. Every reference becomes its short form, and an absent pick is an
 * explicit `null` rather than a missing key — a consumer reading `.pick` needs the two to be the same
 * shape, and `undefined` would drop the key entirely on the way through `JSON.stringify`.
 */
export function selectionJson(selection: Selection): SelectionJson {
	return {
		pick: selection.pick === null ? null : candidateJson(selection.pick),
		decision:
			selection.decision === null
				? null
				: selection.decision.kind === "only-candidate"
					? { kind: "only-candidate" }
					: { kind: "rung", rung: selection.decision.rung, over: formatTicketRef(selection.decision.over) },
		consulted: selection.consulted,
		ranked: selection.ranked.map(candidateJson),
		counts: selection.counts,
		degraded: selection.degraded.map((degrade) => degrade.kind),
		unreadPrioritySignals: selection.unreadPrioritySignals,
		filter: selection.filter,
	};
}

function candidateJson(candidate: Candidate): CandidateJson {
	return {
		ref: formatTicketRef(candidate.ref),
		title: candidate.title,
		url: candidate.url,
		labels: candidate.labels,
		blocked: candidate.blocked,
		priority: candidate.priority,
		unreadPriority: candidate.unreadPriority,
		unblocks: candidate.unblocks,
	};
}

/** How many runners-up the human rendering names before summarising the rest. */
const RUNNERS_UP = 5;

const DEGRADE_REASON: Record<Degrade["kind"], string> = {
	truncated: "the ticket set was truncated, so a better candidate may not have been read",
	"unconfirmed-blocking": "no candidate's blockers could be confirmed closed, so this pick may be blocked",
};

export function renderSelection(selection: Selection): string {
	const lines: string[] = [];

	if (selection.pick === null) {
		lines.push("no candidate to recommend");
	} else {
		lines.push(`${formatTicketRef(selection.pick.ref)} — ${selection.pick.title}`);
		if (selection.pick.url !== null) lines.push(`  ${selection.pick.url}`);
		lines.push(`  ${renderDecision(selection)}`);
		lines.push(`  ${renderSignals(selection.pick)}`);
		lines.push(...renderRunnersUp(selection.ranked));
	}

	lines.push("");
	lines.push(renderCounts(selection.counts));
	if (selection.unreadPrioritySignals.length > 0) {
		lines.push(`note: priority labels the ladder does not read: ${selection.unreadPrioritySignals.join(", ")}`);
	}
	for (const degrade of selection.degraded) lines.push(`${DEGRADED_PREFIX}${DEGRADE_REASON[degrade.kind]}`);

	return `${lines.join("\n")}\n`;
}

function renderDecision(selection: Selection): string {
	const decision = selection.decision;
	if (decision === null || decision.kind === "only-candidate") return "the only candidate";
	return `won on ${decision.rung} over ${formatTicketRef(decision.over)}`;
}

function renderSignals(candidate: Candidate): string {
	const blocking = candidate.blocked === "unblocked" ? "blocking confirmed" : "blocking unconfirmed";
	return `${renderPriority(candidate)}, unblocks ${candidate.unblocks}, ${blocking}`;
}

/**
 * A candidate carrying only an unread priority label says so here rather than reading "priority none",
 * which is what a candidate carrying no priority label at all says. The two are different situations
 * and ADR-0011 turns on telling them apart.
 */
function renderPriority(candidate: Candidate): string {
	if (candidate.priority !== null) return `priority P${candidate.priority}`;
	if (candidate.unreadPriority.length > 0) return `priority unread: ${candidate.unreadPriority.join(", ")}`;
	return "priority none";
}

/** What the pick beat, which is the only answer to "why not that other one" the ladder can give. */
function renderRunnersUp(ranked: readonly Candidate[]): string[] {
	const rest = ranked.slice(1);
	if (rest.length === 0) return [];
	const lines = ["", "also considered:"];
	for (const candidate of rest.slice(0, RUNNERS_UP)) {
		lines.push(`  ${formatTicketRef(candidate.ref)} — ${candidate.title} (${renderSignals(candidate)})`);
	}
	if (rest.length > RUNNERS_UP) lines.push(`  … and ${rest.length - RUNNERS_UP} more`);
	return lines;
}

function renderCounts(counts: SelectionCounts): string {
	const aside = [
		`${counts.closed} closed`,
		`${counts.claimed} claimed`,
		`${counts.filtered} filtered out`,
		`${counts.candidates} candidates (${counts.confirmed} unblocked, ${counts.unconfirmed} unconfirmed, ${counts.blocked} blocked)`,
	];
	return `${counts.tickets} tickets: ${aside.join(", ")}`;
}
