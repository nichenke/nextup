# A repository whose git directory is not `<checkout>/.git` is turned away

`git init --separate-git-dir <elsewhere>` leaves a `.git` *file* holding `gitdir: <elsewhere>` instead of
a directory. Ticket 08 assumed against that shape without saying so, and an adversarial review found the
assumption. Two facts, both reproduced against git 2.55 rather than reasoned about:

- `git worktree list --porcelain` names the **git directory** as the primary worktree in that layout, not
  the working tree. So `ensure`'s `primary` — which it reads from the first porcelain record — becomes the
  git directory.
- The default worktree root is resolved against `primary`, so it becomes `<git-dir>/.worktrees`. Worktrees
  land inside the repository's administration with no caller-supplied root involved, and the guard that
  refuses a root under `.git` cannot see it, because such a path has no `.git` component.

A session in a worktree there reports `HEAD`, `ORIG_HEAD`, `index`, `index.lock`, `commondir` and `gitdir`
as untracked files in its own working tree, so `git clean -fd` deletes the repository's worktree
administration and `git add -A` commits it.

The repository is refused rather than supported. Supporting it means reading the working tree from
`rev-parse --show-toplevel` and carrying two notions of "primary" — the working tree for paths, the git
directory for administration — through every path decision in the module. Nothing here uses the layout, so
it is turned away at the door: `refuseUnlessOrdinaryLayout` requires the common directory to be
`<primary>/.git`, or the primary itself when the repository is bare.

Bareness is load-bearing and easy to get wrong. A bare repository and a separate git directory both report
a common directory equal to `primary`; only bareness separates them, and it is read from the porcelain
listing already in hand rather than asked for again.

An inherited `GIT_DIR` is a different shape and is **not** what this guards. It cannot reach git through
this tool at all: `defaultRunner` passes no environment to the subprocess, so a `GIT_DIR` in the parent's
environment is not visible to any git it runs.

## Consequences

Bare repositories stay supported, which matters because bare-plus-worktrees is a layout people choose
deliberately, and ADR-0013 resolves the root against the primary for reasons that hold there too.

The refusal is a fifth `WorktreeError` kind, `"unsupported-repository"`, rather than a reading of an
existing one. No path is stale and no root or ticket changes the answer, so neither `stale-directory` nor
`unnameable-ticket` describes it.

This costs one `git rev-parse` per `ensure`, on every run rather than only when a caller names a root,
because the default root is affected too.

Reopening this means deciding to carry a working tree separate from the git directory, which is a change
to what `primary` means and therefore touches ADR-0013's resolution rule as well.
