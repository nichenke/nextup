# Concurrent claim arbitration is out of scope

The claim is one write, and its exit status is the whole verdict. Nothing is read back, no identity is
compared, and no attempt is made to decide whether two starts of the same ticket raced.

The reason is that no sequence of tracker calls can decide it. Every agent here authenticates as the
same identity, so reading the assignees back and finding only that identity is equally consistent with
this session's write and with a sibling session's write a minute earlier. Assignees are a set with no
atomic test-and-set, so both writes succeed and both readers see the same result. A verification step
could therefore detect only two things: that the write did not land, which the exit status already
reports, and that a different person holds the ticket, which the candidate filter already excluded at
fetch time.

Building the partial check anyway would be worse than omitting it. It would imply a guarantee the tool
does not provide, and leave a gap that cannot be closed at this layer permanently open to being
rediscovered.

## Consequences

The claim does not exist yet — it is slice 6 — so these are requirements on it rather than behaviour
already in place.

Claiming must be a single call. Its failure is classified as outage or defect like any other external
call, and a failed claim aborts loudly rather than degrading.

Two sessions on one machine will still collide, because creating the worktree first means the second one
is refused by the branch — see
[docs/adr/0016-the-worktree-is-created-before-the-claim.md](./0016-the-worktree-is-created-before-the-claim.md).
That is a side effect of the ordering, not a guarantee, and it is not advertised as one.

Two sessions on different machines under one identity will both be able to proceed on the same ticket.
That is the accepted cost.

One real compare-and-swap does exist and is deliberately unused: creating a branch ref on the remote is
atomic, and a push that would create an existing ref fails without forcing. Adopting it would make every
start push a branch. If the two-machine case ever proves to hurt, that is the mechanism to reach for.
