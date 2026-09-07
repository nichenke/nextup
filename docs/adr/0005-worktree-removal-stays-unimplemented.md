# Worktree removal stays unimplemented — the harness's cleanup does not cover it

Ticket 03 asked whether the harness's native "keep or remove this worktree?" exit prompt covers
worktrees `nextup` creates, and if so, on what it keys. Reproduced directly against a live session's
`EnterWorktree`/`ExitWorktree` tools, in this repo:

- A worktree created with a bare `git worktree add` — the mechanism `nextup`'s launcher uses — is
  invisible to `ExitWorktree` regardless of its path. Asking it to remove such a worktree, at a path
  matching the harness's own convention (`.claude/worktrees/`) or at this repo's own convention
  (`.worktrees/`), both produced the same refusal: "This tool only operates on worktrees created by
  EnterWorktree in the current session."
- Entering that same manually created worktree via `EnterWorktree(path=...)` made it trackable: a
  subsequent `ExitWorktree` recognized and acted on it. The trigger is a live, in-session flag set by
  the `EnterWorktree` tool call, not a property of the path.
- The flag is momentary, not "entered at some point this session": exiting once with `action: "keep"`
  cleared it — a second `ExitWorktree` call against the same worktree, same session, was again a no-op.

## Consequences

Removal stays out of scope, which is what ADR-0002 says and what this ADR's title asserts. What does
not survive is the *reason* the spec gave for it: "worktree removal is deliberately not implemented,
matching the existing decision to leave removal to the harness's native session-exit prompt."
`nextup`'s launcher issues `git worktree add` through its own injected runner; it never calls the
harness's `EnterWorktree`, and a spawned process could not reach that in-session flag even if it wanted
to. So the decision holds and its stated justification does not — a distinction worth keeping, because
that justification is also what set the default worktree root, and there it produced a wrong answer.

The cost, stated plainly so that nobody has to rediscover it: nothing removes a worktree `nextup`
creates. They accumulate under the worktree root until somebody removes them by hand, and no part of
this tool warns when they do. Reopening that is a new ticket, not an unfinished one — it turns on what
should happen to uncommitted work in a worktree and to the ticket's claim, neither of which the
launcher has any basis to decide.

The default worktree root ticket 08 picks needs no alignment with `.claude/worktrees/` for cleanup's
sake — that path carries no special behavior for a worktree the harness's tools never touched. Root
choice is free to follow this repo's own convention (`.worktrees/`) instead.
