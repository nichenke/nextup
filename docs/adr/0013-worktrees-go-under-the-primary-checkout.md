# Worktrees go under the primary checkout, at a root the caller can move

Ticket 08 had to pick a default worktree root. The spec (nichenke/nextup issue 2) instructs one:
"Root is parametric, defaulting to the harness's worktree directory so that native session-exit
cleanup applies." Ticket 03 reproduced that justification and found it false — ADR-0005 records the
session: the harness's cleanup keys on an in-session flag its own `EnterWorktree` sets, not on a
path, and a worktree created by `git worktree add` gets no cleanup at either location.

So the spec's reason for `.claude/worktrees/` buys nothing, and the default is this repo's own
convention instead:

- **`.worktrees/`**, matching what is already checked out here by hand and what
  `~/.config/git/ignore` already ignores.
- **Resolved against the primary checkout**, not against the directory the tool was invoked in.
  `nextup` does its work inside worktrees; resolving against the caller would nest the next worktree
  under the last one, and the depth would grow with each ticket.
- **Parametric**, which the spec asks for and this keeps: `--worktree-root` takes an absolute path as
  given, so a future Codex launcher sites its worktrees wherever it wants without forking the tool.

The branch is cut from the primary checkout's HEAD for the same reason, which is what makes the
drift warning — "the primary checkout is on X, not on Y" — worth printing at all. A branch based on
whichever worktree happened to invoke the tool would be based on something the output never names.

## Consequences

Nothing removes these worktrees. That is a real gap rather than a deferral, and
nichenke/nextup issue 23 holds the decision about it; ADR-0005 states the finding this rests on.
Until it is settled, worktrees `nextup` creates accumulate until removed by hand.

Spec issue 2 still states the refuted position in three places (the harvest list, the Worktrees
section, and Out of Scope). Patching it is part of issue 23's scope, not this ticket's — but an
implementer reading the spec alone will reach for `.claude/worktrees/` and a cleanup that does not
exist, which is why this ADR names the sentence rather than only the decision.
