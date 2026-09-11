import { type BlockedState, deriveEffectiveBlockedness } from "./effective-blockedness";
import type { NonEmpty } from "./non-empty";
import { type Ticket, ticketId } from "./ticket";
import type { TicketRef } from "./ticket-ref";
import type { TicketRead } from "./ticket-set-read";

/**
 * The pure layer of the override path, standing to a named ticket where `selector.ts` stands to a ticket set:
 * a read in, a verdict out, no side effects — ADR-0002's split, and what lets a decision be asserted exactly.
 *
 * It ranks nothing. The operator named the ticket, so the only question left is whether work can start on it,
 * which ADR-0037 settles check by check.
 */
export interface OverrideInput {
	readonly read: TicketRead;
	/** Whether the operator asked to proceed past the checks `clearedByForce` admits. */
	readonly force: boolean;
}

/**
 * One check that failed, carrying what it needs to be reported without a second read: who holds the claim, and
 * which blockers are open. Kinds rather than sentences, the division `ReadDegrade` draws for the same reason —
 * a render boundary words them, so a test of the decision asserts the decision.
 */
export type Refusal =
	| { readonly kind: "closed" }
	/** Null where the tracker records a claim without naming whose — still a claim; `Claim` has why. */
	| { readonly kind: "claimed"; readonly by: string | null }
	| { readonly kind: "blocked"; readonly blockers: readonly TicketRef[] };

/**
 * The ticket a named reference points at, with the blocking state derived over the read's graph.
 *
 * Deliberately not a `Candidate` — `CONTEXT.md`'s **Target** defines the distinction and ADR-0037 argues it. The
 * half that binds code here: `blocked` is the whole tri-state, where `Candidate.blocked` promises never to be
 * `"blocked"` and a forced target can be.
 */
export interface Target {
	readonly ticket: Ticket;
	readonly blocked: BlockedState;
}

/**
 * What the override decided. A union rather than a flag beside a list, so the refused arm cannot be read as
 * startable: its `refusals` is non-empty by type, and `forced` on the other arm is empty wherever nothing
 * needed clearing — which is what keeps the warning from ever being spurious.
 */
export type Override =
	| { readonly kind: "refused"; readonly target: Target; readonly refusals: NonEmpty<Refusal> }
	| {
			readonly kind: "startable";
			readonly target: Target;
			/**
			 * The checks `--force` cleared, to be reported loudly; empty where it cleared none. `Clearable` rather
			 * than `Refusal`, so a started run cannot be constructed claiming to have forced past a closed ticket —
			 * the one rule ADR-0037 treats as categorical is then a type fact rather than this function's promise.
			 */
			readonly forced: readonly Clearable[];
	  };

/** A check `--force` is allowed past, which is every one but the closed ticket — ADR-0037. */
export type Clearable = Exclude<Refusal, { readonly kind: "closed" }>;

/** A check `--force` cannot clear, named so that a refusal's advice can be keyed on the set rather than guessed. */
export type Unclearable = Exclude<Refusal, Clearable>;

/**
 * Whether `--force` is allowed past one check.
 *
 * Both the decision below and the wording of a refusal read this, so they cannot come to disagree about what
 * the flag offers — a refusal advising `--force` where the flag would not help is worse than no advice.
 *
 * A closed ticket is the one it does not reach: ADR-0037 has why, and that the repair is to reopen it.
 *
 * A switch rather than `kind !== "closed"`, and a predicate rather than a boolean, so that the policy is not
 * permissive by default: a check added to `Refusal` later fails to compile here until somebody decides whether
 * the flag clears it, where the inequality would have silently admitted it.
 */
export function clearedByForce(refusal: Refusal): refusal is Clearable {
	switch (refusal.kind) {
		case "closed":
			return false;
		case "claimed":
		case "blocked":
			return true;
	}
}

/**
 * Whether work can start on the named ticket, and what had to be overruled for it to.
 *
 * Every failed check is reported rather than the first, so fixing one does not reveal the next — and a closed
 * ticket that is also claimed says both, since `--force` answers only half of that. They come back in the order
 * `refusalsFor` fixes, which is the order a refusal prints them in.
 */
export function decideOverride(input: OverrideInput): Override {
	const ticket = input.read.ticket;
	const target: Target = { ticket, blocked: deriveEffectiveBlockedness(ticketId(ticket.ref), input.read.graph) };
	const refusals = refusalsFor(target, input.read);

	const [first, ...rest] = refusals;
	if (first === undefined) return { kind: "startable", target, forced: [] };
	// Filtered rather than `every`, which answers the same question without narrowing the array it answered it
	// about: the comparison is what says every refusal survived, and `filter` is what gives `forced` its type.
	const clearable = refusals.filter(clearedByForce);
	if (input.force && clearable.length === refusals.length) return { kind: "startable", target, forced: clearable };
	return { kind: "refused", target, refusals: [first, ...rest] };
}

/**
 * The checks, in the order a person reads them: whether there is work, whether somebody else has it, whether
 * it can be started. `place` in `selector.ts` asks these three of a candidate and the label filter as well;
 * here the filter is absent because naming a ticket is the override, and `Unknown` is absent from the third
 * because it is not blocked — both per ADR-0037.
 */
function refusalsFor(target: Target, read: TicketRead): readonly Refusal[] {
	const refusals: Refusal[] = [];
	if (target.ticket.state === "closed") refusals.push({ kind: "closed" });
	// Strictly claimed, for the reason `Claim` gives: a claim recording no claimant is still a claim.
	if (target.ticket.claim !== null) refusals.push({ kind: "claimed", by: target.ticket.claim.by });
	if (target.blocked === "blocked") refusals.push({ kind: "blocked", blockers: openBlockers(target.ticket, read) });
	return refusals;
}

/**
 * The blockers a refusal names: this ticket's own, that the graph confirms open.
 *
 * Only the open ones, because a list including the satisfied edges sends a reader to look at a closed ticket
 * for the reason their work is held up. Asking the graph is reading the openness the adapter already put there
 * rather than a second opinion: a closed blocker is pruned from the derivation, so a `blocked` verdict here
 * means one of these is open, and the refusal names the ones to go close.
 *
 * A ticket whose blockers could not be listed never derives `blocked`, so the empty result is unreachable
 * through `decideOverride`. `refusalReason` words it anyway, as the defence against a reader that is not
 * `decideOverride`.
 */
function openBlockers(ticket: Ticket, read: TicketRead): readonly TicketRef[] {
	if (ticket.blockers === "unknown") return [];
	return ticket.blockers.filter((blocker) => read.graph.isOpen(ticketId(blocker)) === true);
}
