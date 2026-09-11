import type { DependencyGraph } from "./effective-blockedness";
import type { Ticket } from "./ticket";
import type { TicketRef } from "./ticket-ref";

/**
 * A way one read answered with less than it was asked. Kinds rather than sentences, following how `Degrade` and
 * `DEGRADE_REASON` divide the same job: a caller decides on the kind, and only a render boundary writes prose.
 * A test asserting wording instead pins text `selection-output.ts` declares free to change.
 *
 * `readDegradeReason` in `selection-output.ts` is the boundary that words them, beside `DEGRADE_REASON` for
 * the selector's own union.
 *
 * `outage` is the only one named for a failure of the call. The other two are the tracker answering, with less
 * than one answer in it — which is why neither is filed under a word `failure-class.ts` reserves for
 * connectivity and the tracker erroring.
 */
export type ReadDegrade =
	| { readonly kind: "outage"; readonly detail: string }
	| { readonly kind: "unreadable-blocking"; readonly tickets: number; readonly of: number }
	/** Tickets held out of the answer because only a page of their blockers arrived — never recommended. */
	| { readonly kind: "partial-blocking"; readonly refs: readonly TicketRef[] }
	| { readonly kind: "contradicted-blocker"; readonly refs: readonly TicketRef[] };

/**
 * One read of a single named ticket, for the override path — where the ticket was chosen rather than found, so
 * there is no set to account for and nothing to rank.
 *
 * Beside `TicketSetRead` for the reason that type gives, and with no `truncated` or `openOnly` of its own:
 * one named ticket is never a page of a larger answer, and the read carries whatever state the ticket is in
 * because a closed one is a refusal to word rather than a row to drop.
 *
 * The ticket is always here, whatever its blocking field said. A set read holds a ticket out of the answer
 * when only a page of its blockers arrived; doing that here would refuse the one ticket the operator named,
 * so the graph is seeded unknown and `degraded` says a page is what came back — ADR-0037.
 */
export interface TicketRead {
	readonly ticket: Ticket;
	/** Spans the ticket and every blocker its edges named, each on the openness its own edge carried. */
	readonly graph: DependencyGraph;
	/** Every way this read answered with less than it was asked, already reflected in `ticket` or in `graph`. */
	readonly degraded: readonly ReadDegrade[];
}

/**
 * One read of a ticket set: the tickets, the blocking graph over them, and what the read could not answer.
 *
 * Here rather than beside an adapter, because the render boundary and the command both read this shape: with
 * it declared in the GitHub adapter, a second tracker's adapter would have to import GitHub's contract to be
 * renderable at all, which inverts the dependency the shallow-adapter split (CONTEXT.md) rests on.
 *
 * `truncated` is separate from `degraded` because it calls for a different response — a narrower query rather
 * than a look at the tracker — and because a read can be both. Neither implies the other: an outage reports
 * both, while a read whose blocking nothing could confirm is degraded and complete. So a caller has to consult
 * both, and `truncated === false` is not a claim that the answer is whole.
 */
export interface TicketSetRead {
	readonly tickets: readonly Ticket[];
	/**
	 * Spans every row the read returned, plus every blocker named by an edge it could read — including blockers
	 * outside `tickets`, since one the read stopped short of still gates its dependent, on the openness its own
	 * edge carried. A row whose blocking field did not answer contributes no edges, so nothing is seeded for
	 * blockers only it would have named.
	 */
	readonly graph: DependencyGraph;
	/** Whether the read stopped short of the whole ticket set. */
	readonly truncated: boolean;
	/**
	 * Whether this read asked for open tickets only, which `SelectionInput.openOnly` requires stated and
	 * only the query knows.
	 */
	readonly openOnly: boolean;
	/**
	 * Every way this read answered with less than it was asked, each already reflected as `"unknown"` in
	 * `tickets` or in `graph`, or as an empty set. Empty for a read that answered everything. A defect never
	 * reaches here — it throws.
	 */
	readonly degraded: readonly ReadDegrade[];
}
