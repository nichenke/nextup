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

There is no release path and no rollback. `ensure()` is idempotent, so re-running after any failure
attaches to the worktree already present and retries the claim — recovery is the ordinary path, not a
separate one.

The leftover on failure is a worktree, which `git worktree list` reports, costs nothing, and is reused
by the next attempt. The alternative leftover, a claim with no work behind it, is visible only inside
the tracker and actively misinforms every other session.

Two sessions racing the same ticket in one repository collide on the branch, and `ensure()`'s
branch-attached-elsewhere refusal fires before any network call. That is a local mutex obtained for
free, and it is loud.

Tests assert one argv sequence with no failure-branch matrix, because the failure behaviour is to stop.

This does not make concurrent claims safe across machines. GitHub assignees are a set with no atomic
test-and-set, so no compare-and-swap primitive exists to build on; claiming is best-effort because that
is what the API offers, not as a deferral. `agent-bakeoff` issue 151 asks for the stronger guarantee
that two concurrent starts cannot both end claimed, and that guarantee is unavailable at this layer.
