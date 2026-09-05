# A markdown effort reaches the launched session only when it is committed, and the run says when it does not

The handover to a launched session is the bare ticket reference. For the three trackers to come that
is self-contained — `gh:example/repo#1` names its own repository. A markdown reference carries
neither host nor repo: `md:1` means "ticket 1 of the sole effort under the session's own `.scratch`",
and whether that resolves depends on where the session is started.

Ticket 07 raised this against ticket 08 (nichenke/nextup issue 10), because the worktree decision
settles it. A worktree is a checkout of a branch. So the effort reaches it exactly when the effort is
committed on that branch, and not otherwise — `.scratch` is in neither this repo's `.gitignore` nor
the user-level one, so the answer is whatever the author chose, and a directory named "scratch"
suggests untracked more often than not.

Three things this could have done, and why this one:

- **Copy the effort into the worktree.** Rejected. An effort deliberately left untracked is not
  something this tool should be writing into a branch, and a copy is a second source that drifts from
  the first the moment either is edited.
- **Refuse to launch where the effort will not reach.** Rejected. It is a real workflow to start the
  session in the checkout that holds the effort, and refusing would break it to protect against a case
  the person may already have handled.
- **Warn, and let the run stand.** Adopted. The failure this replaces is silent: the session simply
  cannot find the ticket it was told to implement, and nothing says why.

## Consequences

After the worktree is ensured, the run checks whether the effort's own path exists inside it and
prints a warning naming both the path and the reference where it does not. An effort outside the
primary checkout entirely — reached by an absolute `--effort` — gets the same treatment, since a
relative reference will not find that either.

The check is a filesystem read of the worktree that was just made, so it costs a `stat` and answers
about the tree the session will actually start in, rather than about what git ought to have checked
out.

This is a warning, not a gate: exit status is unaffected and the claim stands. Ticket 09 launches the
session, and it inherits this — the reference it hands over is the one this warns about.
