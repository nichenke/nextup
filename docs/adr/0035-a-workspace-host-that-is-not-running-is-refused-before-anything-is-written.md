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

[0016](./0016-the-worktree-is-created-before-the-claim.md) orders the worktree before the claim so that a
failure leaves a directory on disk rather than an operator's name parked on work nobody is doing. It says
nothing about a failure *after* the claim, and starting a session is exactly that. So a workspace host
that is not running would leave both a worktree and a claim — the leftover 0016 rejected, reached by the
step 0016 did not consider.

Asking the host whether it is there, before either write, turns the one cause of a failed launch that a
person can act on into a refusal that has written nothing.

This narrows the failure and does not close it. The host can still go away between the check and the
creation, and there the creation's own exit status is the verdict. That residual failure keeps 0016's
ordering and its consequence: nothing unwinds, the worktree and the claim stay, and the abort says so, so
that re-running continues from them rather than starting over.

## Consequences

`--print-command` becomes the answer for an operator whose host is down, rather than only the sandbox-safe
path [0002](./0002-pure-selector-separate-launcher.md) describes. It is the same output either way; what
changes is that it is now named in the refusal, so the message leaves a person with something to do.

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
