import { type NonEmpty, mapNonEmpty } from "./non-empty";
import { type Override, type Refusal, type Target, type Unclearable, clearedByForce } from "./override";
import { blockingPhrase, degradedLine, readCaveats } from "./selection-output";
import type { Ticket } from "./ticket";
import { formatTicketRef } from "./ticket-ref";
import type { ReadDegrade } from "./ticket-set-read";

/**
 * The prefix every line naming a check `--force` cleared carries, so a caller can find a forced start with
 * `grep '^forced: '` rather than by matching the prose after it. Greppable and stable for the reason
 * `DEGRADED_PREFIX` is: the prose is free to change and this is the contract.
 */
export const FORCED_PREFIX = "forced: ";

/** One override's whole answer: what was decided, and what the read that produced it could not answer. */
export interface OverrideAnswer {
	readonly override: Override;
	readonly readDegraded: readonly ReadDegrade[];
}

/**
 * The named ticket and what starting it takes, as the lines printed before the start's own.
 *
 * No counts line and no deciding rung — ADR-0037. What replaces them is the line saying the ranking was
 * skipped, because a reader who sees a ticket they did not expect needs to know which path chose it.
 */
export function renderOverride(answer: OverrideAnswer): string {
	const { target } = answer.override;
	const lines = [`${formatTicketRef(target.ticket.ref)} — ${target.ticket.title}`];
	if (target.ticket.url !== null) lines.push(`  ${target.ticket.url}`);
	lines.push("  named directly, so the ranking was not consulted");
	lines.push(`  ${blockingPhrase(target)}, ${claimPhrase(target.ticket)}`);
	lines.push("");
	for (const caveat of readCaveats(answer.readDegraded, "kept")) lines.push(degradedLine(caveat));
	return `${lines.join("\n")}\n`;
}

/**
 * What `--force` cleared, one greppable line each, for a run that went through with it.
 *
 * Separate from `renderOverride` because the decision is not the outcome: a run whose gate was declined cleared
 * nothing, and printing these beside "was not started" contradicted it on the next line — while `FORCED_PREFIX`
 * promises that line marks a forced start. The caller emits these only for a run that started.
 */
export function renderForced(override: Override): string {
	if (override.kind !== "startable") return "";
	return override.forced.map((refusal) => `${forcedLine(refusal)}\n`).join("");
}

/**
 * Why nothing was started, with every failed check named and what to do about them.
 *
 * The advice is decided by `clearedByForce` rather than written per kind, so a refusal cannot offer `--force`
 * for something the flag does not reach — which is the one wrong thing this message could say.
 */
export function renderRefusal(answer: OverrideAnswer): string {
	const override = answer.override;
	if (override.kind !== "refused") return "";
	const what = formatTicketRef(override.target.ticket.ref);
	const reasons = override.refusals.map((refusal) => `  ${refusalReason(refusal)}`).join("\n");
	// The read's degrades come too: without them a refusal advises forcing past a claim while saying nothing about
	// a blocking read that arrived incomplete, which is the one caveat that changes whether forcing is wise.
	const caveats = readCaveats(answer.readDegraded, "kept").map((caveat) => `${degradedLine(caveat)}\n`);
	return `${what} was not started, and nothing was claimed or created:\n${reasons}\n${caveats.join("")}${advice(override.refusals)}\n`;
}

/**
 * What to do instead, per check `--force` cannot clear.
 *
 * A `Record` keyed on those kinds rather than one sentence in an else arm: `clearedByForce` is an exhaustive
 * switch so that a check added later has to decide whether the flag clears it, and a second non-clearable kind
 * would otherwise inherit the wording written for the only one there is today. Keyed, it fails to compile here.
 */
const REMEDY: Record<Unclearable["kind"], string> = {
	closed: "--force does not reach a closed ticket: reopen it if the work is not done.",
};

function advice(refusals: NonEmpty<Refusal>): string {
	const unreachable = refusals.find((refusal): refusal is Unclearable => !clearedByForce(refusal));
	if (unreachable === undefined) {
		return "Pass --force to start it anyway, which claims it besides — the claim is added rather than replacing one, so an existing claimant keeps theirs.";
	}
	return REMEDY[unreachable.kind];
}

/**
 * One cleared check, on its own greppable line. The reason is `refusalReason`'s, so the warning and the
 * refusal cannot come to describe one check differently — the warning is the only report of it a forced run
 * gets, and it is the gate's line too.
 */
function forcedLine(refusal: Refusal): string {
	return `${FORCED_PREFIX}started it anyway, though it is ${refusalReason(refusal)}`;
}

/**
 * Every check a forced start cleared, unprefixed and one to a line, for the confirmation gate — which cannot
 * reach the lines above any other way, because `run` returns its rendering rather than writing it. Shared with
 * the rendering for the reason `answerCaveats` is.
 */
export function forcedCaveats(override: Override): readonly string[] {
	return override.kind === "startable" ? override.forced.map((refusal) => `starting past it being ${refusalReason(refusal)}`) : [];
}

function refusalReason(refusal: Refusal): string {
	switch (refusal.kind) {
		case "closed":
			return "closed, so there is no work to start";
		case "claimed":
			return refusal.by === null ? "claimed, by a claimant the tracker did not name" : `claimed by ${refusal.by}`;
		case "blocked":
			return `blocked by ${refusal.blockers.map(formatTicketRef).join(", ") || "a blocker that is open"}`;
	}
}

/** How the claim reads on the target's own line, beside its blocking state. */
function claimPhrase(ticket: Ticket): string {
	if (ticket.claim === null) return "unclaimed";
	return ticket.claim.by === null ? "claimed, with no claimant named" : `claimed by ${ticket.claim.by}`;
}

/**
 * The JSON forms are their source types with only the fields that change shape restated, for the reason
 * `selection-output.ts` gives: spelled out in full, a field added to `Ticket` or `Refusal` would reach neither
 * the type nor the output, and nothing would fail.
 */
export type TicketJson = Omit<Ticket, "ref" | "blockers"> & {
	readonly ref: string;
	readonly blockers: readonly string[] | "unknown";
};

export type TargetJson = Omit<Target, "ticket"> & { readonly ticket: TicketJson };

export type RefusalJson =
	| Exclude<Refusal, { readonly kind: "blocked" }>
	| (Omit<Extract<Refusal, { readonly kind: "blocked" }>, "blockers"> & { readonly blockers: readonly string[] });

export type OverrideJson =
	| (Omit<Extract<Override, { readonly kind: "refused" }>, "target" | "refusals"> & {
			readonly target: TargetJson;
			readonly refusals: NonEmpty<RefusalJson>;
	  })
	| (Omit<Extract<Override, { readonly kind: "startable" }>, "target" | "forced"> & {
			readonly target: TargetJson;
			readonly forced: readonly RefusalJson[];
	  });

export function overrideJson(override: Override): OverrideJson {
	const target = targetJson(override.target);
	return override.kind === "refused"
		? { ...override, target, refusals: mapNonEmpty(override.refusals, refusalJson) }
		: { ...override, target, forced: override.forced.map(refusalJson) };
}

function targetJson(target: Target): TargetJson {
	return { ...target, ticket: ticketJson(target.ticket) };
}

function ticketJson(ticket: Ticket): TicketJson {
	return {
		...ticket,
		ref: formatTicketRef(ticket.ref),
		blockers: ticket.blockers === "unknown" ? "unknown" : ticket.blockers.map(formatTicketRef),
	};
}

function refusalJson(refusal: Refusal): RefusalJson {
	return refusal.kind === "blocked" ? { ...refusal, blockers: refusal.blockers.map(formatTicketRef) } : refusal;
}
