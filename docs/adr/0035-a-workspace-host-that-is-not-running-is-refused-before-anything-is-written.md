# A workspace host that is not running is refused, before anything is written

The spec asked for a fallback. Issue 2's user story 26 wanted a new terminal opened when the workspace
host is not running, "so that a dependency being down does not block me", and its Launching section said
the same in one line. Issue 11 carried it as an acceptance criterion. There is no fallback.

## Why neither available fallback was worth having

Two shapes exist on this platform and each fails the thing a fallback is for.

`open -a Terminal <dir>` carries no command. It opens a shell in the worktree and stops, so the operator
still types the session themselves — which `--print-command` already gives them, without a second code
path, and without needing the run to have created a worktree first. A fallback that ends in the operator
typing the command is not a fallback; it is a longer route to the flag.

Running the command needs AppleScript, and that is the one this decision turns on. `formatCommand` renders
argv as a shell line, and its whole contract had been that the line is never executed — the runner takes
argv, so a quoting bug in it could reach a reader and no further. An AppleScript route puts a second
quoting layer on top of that, in the one direction where a mistake is executed rather than read. The
escape set for an AppleScript string literal is small and closed, so this was tractable rather than
impossible; it was not worth buying, because what it buys is the case above.

## Why the refusal happens before the worktree and the claim

[0016](./0016-the-worktree-is-created-before-the-claim.md) orders the worktree before the claim, and it is
explicit that the deciding argument is which order needs no recovery code rather than which leftover is more
visible: claim-first has to release the claim when a later step fails, and that release is itself a network
call that can fail. Its Consequences then require what the leftover must be — a worktree, which
`git worktree list` reports and the next attempt reuses, rather than a claim advertising work nobody is doing.

0016 orders two writes. Starting a session is a third, and 0016 says nothing about a failure after the claim
— so a workspace host that is not running would leave both a worktree and a claim behind a session that
never started, which is the leftover its Consequences reject, reached by a step it did not consider.

Asking the host whether it is there, before either write, turns the one cause of a failed launch that a
person can act on into a refusal that has written nothing.

This narrows the failure and does not close it. The host can still go away between the check and the
creation, and there the creation's own exit status is the verdict. That residual failure keeps 0016's
ordering and its consequence: nothing unwinds, the worktree and the claim stay, and the abort says so, so
that re-running continues from them rather than starting over.

## Consequences

Re-running is not the recovery for a session that fails after the claim landed, and the abort must not say it
is. 0016's Consequences make re-running the ordinary path because `ensure()` is idempotent and a failed claim
can simply be retried — but a claim that *succeeded* takes the ticket out of the candidate set, since `place`
in `selector.ts` drops any ticket carrying a claim before the ladder runs. So a re-run cannot reach this ticket
at all: it would claim and start a different one, leaving the original claimed with nobody working it and a
worktree nothing points at. The abort therefore hands over the session command to run in the worktree, and only
the earlier failures are told to re-run. Releasing the claim is still not the alternative — 0016 forbids a
release path, and the release is itself a call that can fail.

This is the one place the launch step narrows what 0016 promised, and it is a property of ordering rather than
of this decision: any third write after the claim would reach it.

The refusal prescribes nothing. A host that does not answer reports what the probe said and stops, without
offering `--print-command` or any other route: the host is expected to be running — a run is most often
started from inside a session on it — so this path is a genuine failure rather than a situation to be
navigated, and advice written for it would be advice nobody reads. `--print-command` stays what
[0002](./0002-pure-selector-separate-launcher.md) made it, the sandbox-safe bridge.

`formatCommand` acquires an executed caller, and its documentation had to be corrected rather than
extended: the claim that a formatted line is never what the tool executes was true when written and is
now false. The quoting it already did — single quotes, an allowlist deciding what may go unquoted — is
what makes that safe, so this records a change in what the function is relied on for, not a change in the
function.

The confirmation gate is asked after the host check. A person is not asked to approve work that could not
start, and the cost is one local process call on a run that is about to be declined.

A launch has one failure class rather than the outage-and-defect pair the tracker calls carry. Both
answers here are the same — stop, having written whatever the earlier steps wrote — so classifying would
produce a distinction nothing acts on.

This decision is about a host that is not running. It says nothing about a host that is running and
refuses the request, which arrives as the creation's own non-zero exit and is reported as itself.
