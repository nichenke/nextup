import type { LabelFilterSpec } from "./label-filter";
import type { Candidate, Degrade, Rung, Selection, SelectionCounts } from "./selector";
import { formatTicketRef } from "./ticket-ref";

/**
 * The prefix a degraded answer's every reason line carries, so that a caller can test for a degrade
 * with `grep '^degraded: '` rather than by matching the prose after it. The prose is free to change;
 * this is the contract.
 */
export const DEGRADED_PREFIX = "degraded: ";

/**
 * The JSON forms are their source types with only the fields that change shape restated. Spelling them
 * out in full would let a field added to `Candidate` or `Selection` reach neither the type nor the
 * output: `--json` would simply not carry it, and nothing would fail.
 */
export type CandidateJson = Omit<Candidate, "ref"> & { readonly ref: string };

export type DecisionJson =
	| { readonly kind: "only-candidate" }
	| { readonly kind: "rung"; readonly rung: Rung; readonly over: string };

export type SelectionJson = Omit<Selection, "pick" | "decision" | "ranked" | "degraded"> & {
	readonly pick: CandidateJson | null;
	readonly decision: DecisionJson | null;
	readonly ranked: readonly CandidateJson[];
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
		degraded: selection.degraded.map((degrade) => degrade.kind),
	};
}

function candidateJson(candidate: Candidate): CandidateJson {
	return { ...candidate, ref: formatTicketRef(candidate.ref) };
}

const DEGRADE_REASON: Record<Degrade["kind"], string> = {
	truncated: "the ticket set was truncated, so a better candidate may not have been read",
	"unknown-blocking": "no candidate's blockers could be confirmed closed, so this pick may be blocked",
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
	}

	lines.push("");
	lines.push(renderCounts(selection.counts));
	for (const degrade of selection.degraded) lines.push(`${DEGRADED_PREFIX}${DEGRADE_REASON[degrade.kind]}`);

	return `${lines.join("\n")}\n`;
}

/**
 * A lone candidate is only lone among the ones the ladder ranked. Saying "the only candidate" while the
 * counts two lines below report more of them contradicts those counts, and the rest are held back
 * rather than absent — blocked, or in the partition that was never consulted.
 */
function renderDecision(selection: Selection): string {
	const decision = selection.decision;
	if (decision !== null && decision.kind === "rung") {
		return `won on ${decision.rung} over ${formatTicketRef(decision.over)}`;
	}
	return heldBackCount(selection) === 0 ? "the only candidate" : "the only candidate the ladder ranked";
}

/**
 * Candidates the ranking never saw. Every candidate not in `ranked` counts, whatever held it back:
 * counting only the unconsulted partition left a lone pick claiming to be the only candidate while the
 * counts line reported the blocked ones alongside it.
 */
function heldBackCount(selection: Selection): number {
	return selection.counts.candidates - selection.ranked.length;
}

function renderSignals(candidate: Candidate): string {
	const blocking = candidate.blocked === "unblocked" ? "blocking confirmed" : "blocking unknown";
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

function renderCounts(counts: SelectionCounts): string {
	const aside = [
		`${counts.closed} closed`,
		`${counts.claimed} claimed`,
		`${counts.filtered} filtered out`,
		`${counts.candidates} candidates (${counts.unblocked} unblocked, ${counts.unknown} unknown, ${counts.blocked} blocked)`,
	];
	return `${counts.tickets} tickets: ${aside.join(", ")}`;
}
