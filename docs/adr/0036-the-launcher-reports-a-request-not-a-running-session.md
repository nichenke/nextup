# The launcher reports a request, not a running session

An adversarial review of the launch step refused to ship it, for a reason worth recording rather than only
fixing: `launch` returned success when `cmux new-workspace` exited 0, and the run then printed `started
claude '/implement …'`. The host's exit status does not cover that claim. `--command` is documented as sending
text plus Enter to the workspace's shell after creating it, so it reports that the workspace was made and the
keystrokes delivered — never that the shell found the binary, nor that the session survived its first second.

So a missing or broken `claude`, or a session that came up and immediately exited, left the ticket claimed, a
worktree on disk, and a run reporting success at exit 0. Nothing downstream would notice: the recovery message
only fires on a non-zero result from the host, and this path is the one where the host is happy.

## What was rejected: looking afterwards

The obvious fix is to verify. It is available — `cmux top --processes` reports a per-workspace
`tag claude_code "Running" pid=…`, so the state is genuinely observable — and it was still rejected.

A check straight after creation races the session's own startup, so it needs polling and a timeout. That
timeout is a guess about how long `claude` takes to boot on a machine under unknown load, and the two ways of
guessing wrong are not symmetric:

- Too optimistic, and the check passes before anything could have failed — the same false success, with more
  machinery.
- Too pessimistic, and a session that was merely slow is reported as not started. The operator is then handed
  the `cd … && claude …` recovery for work that is already running, which puts two agents on one ticket. The
  tool cannot arbitrate that ([0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md)), so the pessimistic
  direction manufactures exactly the collision the claim exists to prevent.

A false negative here is therefore worse than the overclaim it replaces, and no timeout removes the choice.

## What was done instead

Two things, neither of which needs a timing guess.

**The session binary is checked before anything is written.** `requireSessionBinary` runs `claude --version`
beside the host's own probe, so the likeliest cause of a session that never starts — a binary that is missing,
unrunnable, or broken — is settled while there is still nothing to strand. This is the same shape as
[0035](./0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md)'s host check and
for the same reason: move what can be known cheaply to before the writes.

**What is left is reported as what it is.** The outcome arm is `requested`, not `started`, and the human
rendering says `asked cmux to run …`. `CONTEXT.md`'s **Unknown** rule is the precedent — a state meaning "could
not tell" is never spelled as one of the states it is not — and here the tool genuinely cannot tell.

## Consequences

The gap this closes is a reporting gap, not an execution one. A session that starts and then dies is still not
detected, and a run will still report `requested` for it. That is now honest rather than wrong, and it is the
whole of what this decision buys: the operator and any wrapper learn that the request was accepted, and nothing
claims more.

`--json`'s `start.kind` is `requested` for the success path. A consumer wanting to know whether work is
actually underway has to ask the workspace host, or the tracker, or look — this tool does not answer it, and
`--help` says so rather than leaving a reader to infer it from the word.

Two probes now run before the writes on every start, `cmux ping` and `claude --version`. Both are local, both
are milliseconds, and `--print-command` reaches neither, so the sandbox-safe path
([0002](./0002-pure-selector-separate-launcher.md)) is unaffected.

Reopening this means arguing with the asymmetry above, not merely observing that the state is observable — it
is, and that was never the question.
