import type { IssueId } from "./effective-blockedness";
import type { TicketRef } from "./ticket-ref";

/**
 * A claim on a ticket. `null` is unclaimed; `by` is null where the tracker records that a ticket
 * is claimed without recording who claimed it, which is markdown's case — it has no assignee
 * field, so `Status: claimed` is the whole signal. Collapsing that into `claim: string | null`
 * would force either a fabricated claimant or a read of "unclaimed", and the second one hands
 * out a ticket somebody else is already working.
 */
export interface Claim {
	readonly by: string | null;
}

/**
 * One unit of work in a tracker, normalized to a common shape regardless of which tracker it came
 * from. `state` is the tracker's own per-ticket open/closed truth, never a denormalized or
 * board-cached status.
 *
 * Every property is `readonly` so that an adapter narrowing one in a subtype cannot be widened back
 * through a `Ticket`-typed alias. Without it, TypeScript's mutable properties make such a narrowing
 * unsound: `(md as Ticket).blockers = "unknown"` type-checks and puts the string into a field the
 * subtype has told its readers is an array.
 *
 * `state` and `claim` carry no `"unknown"`, unlike `blockers`, so an adapter that cannot confirm
 * either must throw rather than construct a `Ticket`. Defaulting is what the absent third state
 * would otherwise invite, and both defaults are unsafe: an unconfirmed `state` defaults to open and
 * an unconfirmed `claim` to `null`, which together advertise somebody else's in-flight work as
 * available. Widen to `| "unknown"` when an adapter genuinely needs to degrade instead of refuse.
 */
export interface Ticket {
	readonly ref: TicketRef;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly claim: Claim | null;
	/** `"unknown"` when the tracker could not tell us; never collapsed to an empty list. */
	readonly blockers: readonly TicketRef[] | "unknown";
	/** The ticket's address in its tracker's web UI, absent for a tracker that has no web UI. */
	readonly url: string | null;
	readonly labels: readonly string[];
}

/**
 * The `IssueId` a ticket occupies in the blocking graph. Scheme-prefixed, and repo-qualified where
 * the ref carries a repo, so that a query spanning two projects — which each number their tickets
 * from 1 — cannot collide two distinct tickets onto one node.
 *
 * Markdown carries no repo, and its reference grammar is a bare ticket number, so a markdown id is
 * qualified by nothing and is unique only within one effort. Two efforts both numbering from 1
 * therefore collide. Nothing reaches that today because a graph is built per effort, but a caller
 * that ever merges two efforts into one graph must qualify them before doing so.
 */
export function ticketId(ref: TicketRef): IssueId {
	return ref.repo === null ? `${ref.tracker}:${ref.key}` : `${ref.tracker}:${ref.repo}#${ref.key}`;
}
