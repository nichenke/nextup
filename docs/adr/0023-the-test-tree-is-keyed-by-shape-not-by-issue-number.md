# The test tree is one repository per tracker, keyed by shape rather than by issue number

[0019](./0019-every-recording-is-captured-from-a-test-tree.md) makes a test tree the only thing a recording
is captured from, and calls the trees a maintained asset. This ADR is what that asset is: for GitHub, the
public repository `nichenke/nextup-test-tree-github`, described by `src/test-tree.ts` and built by
`bun run provision:test-tree`.

The spec keys every issue on a synthetic name — `chain-tip`, `mixed-blockers`, `write-target` — and never
on an issue number. A recreated tree does not get the same numbers: GitHub does not reuse a deleted
issue's number, and the five probe issues written while settling the questions below left the real tree
starting at 6. A spec keyed on numbers would describe one instance of the tree instead of the tree, and
the first person to rebuild it would find every edge pointing at the wrong issue. Numbers are resolved at
provisioning time by matching titles, so a title is load-bearing and an edit to one orphans its issue.

The repository is public because 0019's argument for a tree over a judgment is that "whether a test tree
*does* produce it" is "a fact anyone can check by looking at the tree". Anyone can only check what anyone
can read. Nothing there is private by construction: every issue is fictional, and the bodies say so.

## What provisioning reconciles, and what it leaves alone

Provisioning is idempotent, in the `Ensure` sense `CONTEXT.md` gives the worktree: a second run against a
matching tree changes nothing, and a run interrupted halfway heals. It reconciles four things — issues
that do not exist, dependency edges that are missing, assignment, and open or closed state.

Assignment is on that list because the claim path mutates it deliberately. Ticket 37 assigns and
unassigns for real, so the tree has to be restorable afterwards without being rebuilt. `write-target` is
the only issue a test may touch: every other issue's assignment is itself a captured shape, so claiming
one of those changes what the next recording says about it.

Labels and bodies are set once at creation and never reconciled. They drift only if someone edits the
tracker by hand, and a run that silently corrected such an edit would hide it — the edit is worth seeing,
because it means a recording and the tree now disagree.

## A dependency cycle is reachable on GitHub, at three hops and not at two

The tree has to carry a cycle, because the propagation module has a cycle guard and a guard no input
reaches is a guard nobody has tested. Whether GitHub permits one was not obvious and was settled by
probe rather than by reading.

GitHub refuses an edge whose **direct** reverse already exists, with `422` and "this dependency would
create a cycle where the target is already blocked by the source". It accepts an edge that closes a
longer loop: with `B` blocked by `A` and `C` blocked by `B` already recorded, adding `A` blocked by `C`
succeeded, and all three issues then reported one blocker each. So the tree's cycle is three hops, no two
of which are a direct pair.

Had it gone the other way, the honest answer would have been that the shape is untestable from a GitHub
recording and stays covered only by hand-authored scenario inputs — 0019's point that an inability to
recreate a shape "is information about the shape, not an obstacle to route around".

## Consequences

The tree's shape is asserted in `src/test-tree.test.ts`, one test per requirement, so narrowing the tree
fails a test rather than quietly reducing what the corpus covers.

A second tracker gets its own repository and its own spec rather than a shared one. Nothing here is
generic across trackers, and the dependency-cycle result above is exactly the kind of finding that will
not transfer.

The provisioner reaches the tracker only through the injected runner seam, so its whole sequence is
asserted against a fake that enforces GitHub's direct-reverse refusal. A spec whose cycle relied on a
direct pair fails in the test suite, before anyone runs it against the tracker.
