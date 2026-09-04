/**
 * effective-blockedness.test.ts — isolation tests for the effective-blocked-ness deep module.
 *
 * Drives `deriveEffectiveBlockedness` through an in-memory `DependencyGraph` fixture built
 * from synthetic maps — no tracker, no network. Each `#### Scenario:` in
 * specs/transitive-blocked-derivation/spec.md maps to one test here. The fixture records
 * every relation read so pruning can be asserted structurally (a closed blocker's own
 * upstream is never consulted).
 */

import { describe, expect, test } from "bun:test";
import {
  deriveEffectiveBlockedness,
  type BlockedState,
  type DependencyGraph,
  type IssueId,
} from "./effective-blockedness";

/**
 * Synthetic node: its parent, its blocked_by targets, and whether it is open. Each field
 * may be the literal "unknown" to model a failed/skipped tracker read (null≠zero per
 * ADR-0010). `parent` may also be null (a true tier root with no ancestor).
 */
interface Node {
  parent?: IssueId | null | "unknown";
  blockers?: IssueId[] | "unknown";
  isOpen?: boolean | "unknown";
}

/**
 * recordingGraph — an in-memory DependencyGraph over a map of nodes that also records
 * which ids each relation was read for. A missing node defaults to a tier root with no
 * blockers; `isOpen` defaults to true (an item under consideration is presumed open
 * unless the fixture says otherwise). The read logs let pruning tests assert that a
 * closed blocker's upstream relations are never consulted.
 */
function recordingGraph(nodes: Record<IssueId, Node>): {
  graph: DependencyGraph;
  reads: { parent: IssueId[]; blockers: IssueId[]; isOpen: IssueId[] };
} {
  const reads = { parent: [] as IssueId[], blockers: [] as IssueId[], isOpen: [] as IssueId[] };
  const graph: DependencyGraph = {
    parent(id) {
      reads.parent.push(id);
      const n = nodes[id];
      return n?.parent === undefined ? null : n.parent;
    },
    blockers(id) {
      reads.blockers.push(id);
      const n = nodes[id];
      return n?.blockers === undefined ? [] : n.blockers;
    },
    isOpen(id) {
      reads.isOpen.push(id);
      const n = nodes[id];
      return n?.isOpen === undefined ? true : n.isOpen;
    },
  };
  return { graph, reads };
}

describe("deriveEffectiveBlockedness", () => {
  // Scenario: Self has an open blocker derives blocked
  test("self has an open blocker → blocked", () => {
    const { graph } = recordingGraph({
      item: { parent: null, blockers: ["blk"] },
      blk: { isOpen: true },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("blocked");
  });

  // Scenario: Ancestor has an open blocker derives blocked (self count 0)
  test("ancestor has an open blocker, self count 0 → blocked", () => {
    const { graph } = recordingGraph({
      item: { parent: "proj", blockers: [] },
      proj: { parent: null, blockers: ["blk"] },
      blk: { isOpen: true },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("blocked");
  });

  // Scenario: Cross-chain blocker derives blocked (blocker in a different subtree)
  test("cross-chain open blocker in a different subtree → blocked", () => {
    const { graph } = recordingGraph({
      item: { parent: "projA", blockers: ["otherWs"] },
      projA: { parent: null, blockers: [] },
      // otherWs lives under a different Project subtree; only its openness matters.
      otherWs: { parent: "projB", isOpen: true },
      projB: { parent: null },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("blocked");
  });

  // Scenario: Closed cross-chain blocker does not block — and the closed blocker's own
  // upstream (its parent / its own blockers) is never read (pruning).
  test("closed cross-chain blocker → unblocked, and its upstream is never read", () => {
    const { graph, reads } = recordingGraph({
      item: { parent: null, blockers: ["closedBlk"] },
      // The closed blocker itself has an OPEN blocker that MUST be ignored (pruned).
      closedBlk: { parent: "closedBlkParent", blockers: ["wouldBlock"], isOpen: false },
      wouldBlock: { isOpen: true },
      closedBlkParent: { parent: null, blockers: ["alsoIgnored"] },
      alsoIgnored: { isOpen: true },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unblocked");
    // Pruning: the closed blocker's openness is read, but never its parent or its blockers.
    expect(reads.isOpen).toContain("closedBlk");
    expect(reads.parent).not.toContain("closedBlk");
    expect(reads.blockers).not.toContain("closedBlk");
    // And the transitive nodes behind it are never touched at all.
    expect(reads.isOpen).not.toContain("wouldBlock");
    expect(reads.parent).not.toContain("closedBlkParent");
  });

  // Scenario: Neither self nor any ancestor blocked derives unblocked
  test("no blockers anywhere → unblocked", () => {
    const { graph } = recordingGraph({
      item: { parent: "proj", blockers: [] },
      proj: { parent: "prog", blockers: [] },
      prog: { parent: null, blockers: [] },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unblocked");
  });

  // Scenario: Ancestor blocker closes then descendant unblocks on next read
  test("ancestor blocker closed then re-derive → unblocked", () => {
    const nodes: Record<IssueId, Node> = {
      item: { parent: "proj", blockers: [] },
      proj: { parent: null, blockers: ["blk"] },
      blk: { isOpen: true },
    };
    // First read: ancestor blocker is open → blocked.
    expect(deriveEffectiveBlockedness("item", recordingGraph(nodes).graph)).toBe<BlockedState>(
      "blocked",
    );
    // Blocker closes; re-derive against the updated graph → unblocked.
    nodes.blk = { isOpen: false };
    expect(deriveEffectiveBlockedness("item", recordingGraph(nodes).graph)).toBe<BlockedState>(
      "unblocked",
    );
  });

  // Risk: blocked_by cycle (A blocks B blocks A, both open) terminates with a defined state.
  test("blocked_by cycle terminates and returns a defined state", () => {
    const { graph } = recordingGraph({
      a: { parent: null, blockers: ["b"], isOpen: true },
      b: { parent: null, blockers: ["a"], isOpen: true },
    });
    // a is blocked_by b (open) → blocked. The point is termination, not a hang.
    const result = deriveEffectiveBlockedness("a", graph);
    expect(result).toBe<BlockedState>("blocked");
  });

  // Scenario: Failed parent lookup degrades to unknown, not unblocked (self count 0).
  test("failed parent read, self count 0 → unknown (not unblocked)", () => {
    const { graph } = recordingGraph({
      item: { parent: "unknown", blockers: [] },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unknown");
  });

  // Scenario: Failed blocker-list lookup degrades to unknown, not unblocked.
  test("failed blockers read → unknown (not unblocked)", () => {
    const { graph } = recordingGraph({
      item: { parent: null, blockers: "unknown" },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unknown");
  });

  // Scenario: Confirmed open blocker decides blocked despite an unrelated unknown.
  test("confirmed open blocker AND an unrelated unknown relation → blocked", () => {
    const { graph } = recordingGraph({
      // The item has a confirmed open blocker, but its parent read is unknown.
      item: { parent: "unknown", blockers: ["blk"] },
      blk: { isOpen: true },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("blocked");
  });

  // Scenario: Item with no ancestor edges matches item-level result (zero-ancestor reduction).
  test("zero-ancestor item (parent null) with 0 open blockers → unblocked", () => {
    const { graph } = recordingGraph({
      item: { parent: null, blockers: [] },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unblocked");
  });

  // Extra: a blocker that is present but confirmed closed (item-level) → unblocked.
  test("self has only a closed blocker → unblocked", () => {
    const { graph } = recordingGraph({
      item: { parent: null, blockers: ["blk"] },
      blk: { isOpen: false },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unblocked");
  });

  // Extra: blocker openness itself unknown → unknown (not unblocked).
  test("blocker openness unknown → unknown (not unblocked)", () => {
    const { graph } = recordingGraph({
      item: { parent: null, blockers: ["blk"] },
      blk: { isOpen: "unknown" },
    });
    expect(deriveEffectiveBlockedness("item", graph)).toBe<BlockedState>("unknown");
  });
});
