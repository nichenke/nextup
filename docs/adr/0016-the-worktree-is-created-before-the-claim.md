# The worktree is created before the claim

Starting work on a ticket writes in two places: a claim in the tracker and a worktree on disk. One has
to go first, and the two existing implementations disagree. This spec originally ordered the claim
first, so that a failure would leave a visible wrong state in the tracker rather than an invisible
orphan on disk. `agent-bakeoff`'s `start-ticket.sh` does the reverse and gives the opposing reason in
its header: a claim that lands before the worktree succeeds parks the operator's name on work nobody is
doing, and every other session then reads that ticket as taken.

The worktree is created first. The deciding argument is not which leftover is more visible but which
order needs no recovery code: claim-first requires releasing the claim when a later step fails, and that
release is itself a network call that can fail, so the design that was meant to avoid a stranded claim
contains the path that produces one. Worktree-first has nothing to unwind. A failed claim aborts loudly
and stops.

## Consequences

Neither `ensure()` nor the claim exists yet — they are slices 5 and 6 — so everything below is a
requirement on the launcher when it lands, not a description of behaviour already protected. Today
`planLaunch` builds a session command and nothing else.

The launcher must have no release path and no rollback. `ensure()` must be idempotent, so that
re-running after any failure attaches to the worktree already present and retries the claim, making
recovery the ordinary path rather than a separate one.

The leftover on failure must be a worktree, which `git worktree list` reports, costs nothing, and the
next attempt reuses. The alternative leftover, a claim with no work behind it, is visible only inside
the tracker and actively misinforms every other session.

Two sessions racing the same ticket in one repository will collide on the branch, and `ensure()`'s
branch-attached-elsewhere refusal fires before any network call. That is a local mutex obtained for
free, and it is loud — but it is a consequence of this ordering, not a guarantee this ADR delivers.

Its tests should assert one argv sequence with no failure-branch matrix, because the failure behaviour
is to stop.

This does not make concurrent claims safe across machines, and does not try to —
[0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md) has why that is a scope boundary rather
than an unfinished edge.
