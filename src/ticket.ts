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
 * The `IssueId` a ticket occupies in the blocking graph: every part of the ref that distinguishes one
 * ticket from another, so two tickets cannot land on one node and overwrite each other's openness.
 *
 * All three qualifiers matter, and each was a real collision. Without the repo, two projects numbering
 * from 1 collide. Without the host, two self-hosted GitLab instances sharing a namespace and number
 * collide, and every Jira tenant collapses onto `jira:PROJ-1` because Jira carries no repo at all.
 *
 * Two constraints follow, and they are the reason this is worth reading before adding an adapter:
 *
 * - Refs entering one graph must agree on how much they know. A short form resolved from a git remote
 *   has no host while a pasted URL for the same ticket does, so the two would occupy different nodes —
 *   an adapter must emit one consistent form for a set rather than mixing them.
 * - Markdown has neither host nor repo, so a markdown id is unique only within one effort. A graph is
 *   built per effort today, so nothing reaches that; a caller merging two efforts must qualify first.
 */
export function ticketId(ref: TicketRef): IssueId {
	// A fixed-arity tuple with its nulls kept, rather than the readable parts joined by a delimiter.
	// Joining is not injective over the refs this repo accepts. A short form can carry a colon inside its
	// repo and no host at all, while a URL supplies a host and the remainder of that same path as the
	// repo; joined, the two flatten to one string. Two distinct tickets then shared a graph node and the
	// later one overwrote the earlier's openness. See the pair in `ticket.test.ts`.
	//
	// Escaping the delimiter, or choosing one no tracker permits, would also work and both rest on an
	// assumption about which characters someone else's system allows. This rests on none. Ids are graph
	// keys and never reach a user, so there is nothing to trade away by making them ugly.
	return JSON.stringify([ref.tracker, ref.host, ref.repo, ref.key]);
}
