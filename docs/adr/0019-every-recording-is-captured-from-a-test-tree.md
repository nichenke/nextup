# Every recording is captured from a test tree we can recreate

> Amended by [0024](./0024-a-recordings-hosts-become-a-dot-less-placeholder.md): the synthetic hosts are
> **not** added to the identifier allowlist. That claim appears twice below — once in the capture rule
> ("replaced with a small allowlisted synthetic set") and again in the last section — and neither instance
> stands.
>
> Amended by [0023](./0023-the-test-tree-is-keyed-by-shape-not-by-issue-number.md) on what the GitHub tree
> is, and on one clause here: the tree is **private**, so "a fact anyone can check by looking at the tree"
> means anyone holding a token for it, not any reader. 0023 has why a publicly writable tree defeats the
> consequence this ADR is built on.
>
> Everything else below stands.

This rule governs **recordings** — captured exchanges with a tracker's CLI. It does not govern
**scenario inputs**, which are sets of already-normalized tickets exercising the pure selector. The
distinction is what each artifact claims: a recording asserts that a tracker produces a shape, so it has
to come from one; a scenario input asserts only how the ladder ranks tickets whose shape is ours by
definition, so authoring one by hand claims nothing about any tracker and stays legitimate. Without that
line drawn, the loop the scenario suite exists for — add the smallest set that produces a bad pick, watch
it fail, fix the rule — would require a tracker round-trip per ranking bug.

Recordings are captured from dedicated test issue trees and from nowhere else. Real project repositories
are never a capture source. Identifiers in a captured exchange are replaced with a small allowlisted
synthetic set, one host per tracker.

When a shape turns up in a real repository that we want covered, it is not hand-written into a fixture.
It is recreated on the test tree first and captured from there.

This replaces the rule that governed markdown shapes, and strengthens it. That rule asked whether a
shape was one another tracker *could* produce, which is a judgment, and judgments are what seven rounds
of review churn were spent arguing. The question now is whether a test tree *does* produce it, which is
a fact anyone can check by looking at the tree.

The failure this prevents is a fixture encoding a shape no tracker emits. Every such fixture is a test
that passes while proving nothing, and a reviewer cannot tell one from a real case by reading it.

## Consequences

Live reconstruction against real repositories is a discovery instrument, not a capture source. It finds
shapes the corpus lacks; recreating them on the test tree is what admits them.

No real project data lands in the repository, so continuous integration stays credential-free and free
of work content by construction rather than by review.

The test trees become a maintained asset. A shape that cannot be recreated on one cannot be tested — and
that inability is information about the shape, not an obstacle to route around.

The synthetic hosts are added to the identifier allowlist deliberately, as
[docs/adr/0006-provenance-prevents-leaks-the-guard-is-a-backstop.md](./0006-provenance-prevents-leaks-the-guard-is-a-backstop.md)
requires: a fixed set of synthetic identifiers, not a pattern that accepts a family.
