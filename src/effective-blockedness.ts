/**
 * effective-blockedness.ts — the effective-blocked-ness derivation deep module.
 *
 * A pure graph traversal hidden behind one call: `deriveEffectiveBlockedness(itemId, graph)`.
 * It computes whether an item is effectively blocked over the UNION of two tracker-native
 * relations — containment (the parent chain, up the tier ladder) and dependency (`blocked_by`
 * edges, which may point cross-chain to any subtree). See ADR-0014 and
 * openspec/changes/program-lifecycle-ordering-model (design.md "Deep module", D2; the
 * transitive-blocked-derivation spec).
 *
 * PURE BY CONSTRUCTION: this module never calls the tracker / network. All data arrives
 * through the injected `DependencyGraph` port; the adapter that turns a live tracker into a
 * `DependencyGraph` is a separate, shallow concern kept out of here so the traversal stays
 * unit-testable without mocks-of-mocks.
 *
 * Tri-state everywhere (ADR-0010 null≠zero): every relation read is a confirmed value OR the
 * literal "unknown" when the underlying read failed/was skipped. "unknown" is never collapsed
 * to null/[]/false. Result precedence: a confirmed open blocker → "blocked" (short-circuit);
 * else any consulted "unknown" → "unknown"; else → "unblocked". Confirmed block outranks
 * unknown; unknown outranks unblocked — a failed read must never read as a confident
 * "unblocked".
 */

export type IssueId = string;

export type BlockedState = "blocked" | "unblocked" | "unknown";

/**
 * The graph port. Every relation is tri-state: a confirmed value, or "unknown" when the
 * tracker read failed/was skipped. The traversal is the only consumer; an adapter supplies
 * the implementation.
 */
export interface DependencyGraph {
  /** Containment parent, up the tier chain. null = confirmed tier root; "unknown" = read failed. */
  parent(id: IssueId): IssueId | null | "unknown";
  /** `blocked_by` targets (may be cross-chain). [] = confirmed none; "unknown" = read failed. */
  blockers(id: IssueId): IssueId[] | "unknown";
  /** Whether the issue is open. "unknown" = openness could not be confirmed. */
  isOpen(id: IssueId): boolean | "unknown";
}

/**
 * deriveEffectiveBlockedness — is `itemId` effectively blocked?
 *
 * Walks the parent chain upward from `itemId`; at the item and each ancestor it inspects the
 * node's `blocked_by` blockers. For each blocker it consults `isOpen`:
 *   - open  → the item is blocked; short-circuit immediately.
 *   - closed→ a satisfied edge; PRUNE — do not chase the closed blocker's own upstream.
 *   - unknown → record the degrade and keep looking for a confirmed block.
 * A visited set guards `blocked_by` cycles and shared ancestors so the walk always terminates.
 * After the walk: confirmed open blocker → "blocked"; else any consulted "unknown" → "unknown";
 * else → "unblocked".
 */
export function deriveEffectiveBlockedness(itemId: IssueId, graph: DependencyGraph): BlockedState {
  const visited = new Set<IssueId>();
  let sawUnknown = false;

  // The frontier is the set of nodes whose own `blocked_by` edges gate `itemId`: the item
  // itself plus every containment ancestor. We seed with the item and walk parents upward,
  // enqueueing each node so its blockers are inspected exactly once.
  const queue: IssueId[] = [itemId];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);

    // Inspect this node's own dependency edges.
    const blockers = graph.blockers(node);
    if (blockers === "unknown") {
      // The node's own edges are unverifiable — forbids a confident "unblocked".
      sawUnknown = true;
    } else {
      for (const blocker of blockers) {
        const open = graph.isOpen(blocker);
        if (open === true) return "blocked"; // confirmed open blocker decides immediately
        if (open === "unknown") {
          sawUnknown = true; // openness unverifiable — cannot confirm "unblocked"
        }
        // open === false → satisfied edge: PRUNE (never enqueue the closed blocker).
      }
    }

    // Walk one containment hop up; an ancestor's blockers gate this node's subtree.
    const parent = graph.parent(node);
    if (parent === "unknown") {
      // An ancestor's blockers are unverifiable — forbids a confident "unblocked".
      sawUnknown = true;
    } else if (parent !== null && !visited.has(parent)) {
      queue.push(parent);
    }
  }

  // No confirmed open blocker found. Unknown outranks unblocked.
  return sawUnknown ? "unknown" : "unblocked";
}
