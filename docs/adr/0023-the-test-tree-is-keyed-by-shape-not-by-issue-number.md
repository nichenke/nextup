# The test tree is one repository per tracker, keyed by shape rather than by issue number

[0019](./0019-every-recording-is-captured-from-a-test-tree.md) makes a test tree the only thing a recording
is captured from, and calls the trees a maintained asset. This ADR is what that asset is: for GitHub, the
private repository `nichenke/nextup-test-tree-github`, described by `src/test-tree.ts` and built by
`bun run provision:test-tree`.

The spec keys every issue on a synthetic name — `chain-tip`, `mixed-blockers`, `write-target` — and never
on an issue number. A recreated tree does not get the same numbers: GitHub does not reuse a deleted
issue's number, and the five probe issues written while settling the questions below left the real tree
starting at 6. A spec keyed on numbers would describe one instance of the tree instead of the tree, and
the first person to rebuild it would find every edge pointing at the wrong issue. Numbers are resolved at
provisioning time by matching titles, so a title is load-bearing and an edit to one orphans its issue.

## The repository is private, and its visibility is a security control

It was created public, on the reasoning that 0019's argument for a tree over a judgment — "whether a test
tree *does* produce it" is "a fact anyone can check by looking at the tree" — needs a tree anyone can read.
That was wrong, and adversarial review is what found it.

A public tree is third-party **writable**, not merely readable. The spec titles are published in
`src/test-tree.ts` in a public repository, so they are known; provisioning adopts any issue whose title
matches a spec title; and a ticket's body, its labels and its comments are never reconciled. Those three
facts are individually defensible and jointly a hole: a stranger opens an issue under a known spec title
before the tree exists, provisioning adopts it, gives it real dependency edges, and leaves its body exactly
as written — after which recordings captured from that issue carry a stranger's content while claiming
test-tree provenance. Commenting on an existing issue needs no timing at all.

That defeats the specific thing 0019 buys. Its consequence is that continuous integration stays free of
foreign content "by construction rather than by review"; content anyone can write is content review is the
only defence for.

So visibility is load-bearing here, not cosmetic. Making this repository public again reopens both paths and
requires replacing them with something else first — validating each issue's author against the provisioning
identity is the cheap version, since `author` rides along in the listing call already made.

What that costs is real but smaller than 0019's wording suggests. The check "does the tree produce this
shape?" is still performed by looking at the tree, by whoever holds a token for it — the maintainer, and any
agent acting for them. What a public reader loses is the tree, not the claim: `src/test-tree.ts` is public
and is the authoritative description of every shape, `src/test-tree.test.ts` asserts the shapes are present
in it, and this repository's own continuous integration never contacts the tree at all, so nothing about
verifying the code depends on reaching it.

The duplicate-title refusal below still catches a title collision independently, and would have stopped the
squat on an already-provisioned tree. It is not what closes this: it fires after the fact, and it does not
apply to a tree that does not exist yet, nor to comments at all.

## What provisioning reconciles, and what it leaves alone

Provisioning is idempotent, in the `Ensure` sense `CONTEXT.md` gives the worktree: a second run against a
matching tree changes nothing, and a run interrupted halfway heals. It reconciles four things — issues
that do not exist, dependency edges that are missing, the claim, and open or closed state.

The claim is on that list because the claim path mutates it deliberately. Ticket 37 assigns and unassigns
for real, so the tree has to be restorable afterwards without being rebuilt. `write-target` is the only
issue a test may assign and unassign: every other issue's claim is itself a captured shape, so claiming one
of those changes what the next recording says about it.

`CONTEXT.md` defines a **Claim** as the assignee written into the tracker, and gives "assignment" as a word
to avoid for it. What the tree records is therefore whether an issue *carries* a claim, not who holds one:
that is what the candidate filter reads, so any assignee satisfies a claimed issue and an unclaimed one is
released of every assignee it has.

A ticket's **label assignments** and its body are set once at creation and never reconciled. They drift
only if someone edits the tracker by hand, and a run that silently corrected such an edit would hide it —
the edit is worth seeing, because it means a recording and the tree now disagree.

The **title** is not in that category either, and it is the sharp edge of keying on shape. It is what
reconciliation matches the tracker on, so it is load-bearing for identity rather than merely descriptive.
Renaming an issue by hand does not show up as drift to be noticed later: the next run finds no issue by
that title and creates a fresh one, leaving the renamed original in the repository with its edges and its
claim intact. Editing a title in the spec does the same thing. `validateTestTree` refuses two issues
sharing a title for the same reason — that collapses two keys onto one number and no run afterwards
converges — but nothing can detect the rename itself, because a renamed issue and a deleted one look
identical from the outside.

"Nothing can detect the rename" is true only *given* title identity, and that is worth saying plainly
rather than leaving as an implication. **Considered and not taken:** writing each `key` into the issue body
or into a `key:<name>` label and matching on that instead, which would make a rename both detectable and
repairable with `gh issue edit --title`. It is the better identity, and it is declined here for a reason
that has nothing to do with the scope paragraph below: a marker lives in captured content. Every recording
would carry our bookkeeping, and the first ticket to need a body byte-for-byte would be arguing with it.
Revisit if a rename ever actually happens; the cost of being wrong is one duplicated issue, caught by the
check below.

What *is* detectable is the state a rename leaves behind, and it took review to work out which check does it.

The duplicate-title refusal does **not**. A rename produces two *different* titles — the renamed original and
the fresh issue provisioning creates under the spec title — so nothing collides and that check never fires.
It earns its place for the cases it does cover: a rename onto another spec issue's title, a spec that once
held a duplicate, and an issue filed under a title already in use. It is not the rename control, and an
earlier version of this ADR credited it as one.

The check that does the job is the inverse, over the same listing: any issue the spec does not describe is an
orphan. That is what a rename leaves — along with an issue created by hand, and one filed under any unused
title. Provisioning refuses on it. The cost of not having it: fix a typo in one of these long prose titles
and the next run creates a second issue, leaves the original with its edges and its claim, reports a single
`created` line, and then converges — eighteen issues against a seventeen-issue spec, reporting that every
issue matches, with every later recording carrying the orphan.

A **label definition** is the exception, and the distinction is easy to lose: the name and colour of each
label in `spec.labels` are re-asserted on every run with `gh label create --force`, because a recording
captures a label's colour, so the colour is a property of the spec rather than of whoever created the label
first. That write is unconditional and reports no change, so a hand-edited colour is reset silently — the
one place provisioning heals without saying so.

Only the name and the colour, though: `TestTreeLabel` carries no description, and `--force` with no
`--description` leaves an existing one untouched rather than blanking it — measured against the live tree
by setting a description by hand and re-provisioning. So a label's description behaves like a body: set by
hand, never reconciled, and drifting silently if anyone edits it.

That boundary is the point, not a gap to close later. The provisioner exists to make the tree
reproducible, not to keep it in sync: the four things it reconciles are the ones a rebuild or the write
path disturbs, and nothing else. When the tree needs a shape it does not carry — a different label, a
reworded body, an edge between two issues that a scenario turns out to need — that is a one-off
judgment, and an agent makes it against the tracker directly, or the spec changes and the tree is
rebuilt. Encoding it here would grow a general tracker-sync tool inside a fixture builder, and every
rule it learned would be one more thing to be wrong about the tracker.

Two more measured facts, both worth recording because the fake in the tests would vouch for either answer.

The dependency endpoint answers `200` with an empty list for an issue that has no dependency records, rather
than `404`. Checked against an issue that has never had an edge. Had it been a `404`, `run()` would throw and
the tree could never be built from empty — the primary documented use.

GitHub accepts an edge whose **target is already closed**. Checked by pointing a new edge at `closed-blocker`
while it was closed. So the edge loop and the state loop are independent, and a comment here that claimed
state had to follow edges was describing a constraint that does not exist. It matters beyond tidiness: had
the answer gone the other way, adding a blocker to an existing spec issue would have made every subsequent run
throw at the same write, which would contradict this ADR's claim that an interrupted run heals.

What reconciliation does **not** do, in either case, is remove an edge. It only adds missing ones, and it now
skips the read entirely for an issue the spec gives no blockers — so an edge nobody declared survives, and is
not even looked for. Read "reconciles dependency edges" above as "adds the declared ones".

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
