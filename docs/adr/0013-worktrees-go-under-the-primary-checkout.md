# Worktrees go under the primary checkout, at a root the caller can move

> Amended by [0041](./0041-a-worktree-root-is-resolved-and-only-the-worktree-refuses-a-link.md) on the
> symlink sentence below. Read "refused rather than resolved, at the root and at the worktree itself" as
> refused at the worktree itself, with the root resolved instead — taken literally, the sentence refused
> every root under a system temp directory, contradicting the third bullet in the same body. The rest
> stands, the hazard it records included.

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

Symlinks along that path are refused rather than resolved, at the root and at the worktree itself.
git registers a worktree under the path with its links resolved, so following one leaves two names
for a directory and only the resolved one ever matches a porcelain listing — which showed up as a
second run reporting the branch checked out elsewhere instead of attaching. Resolving them silently
would make that work and would also accept a symlinked worktree, which nothing here needs.

## Consequences

Nothing removes these worktrees, and nothing is going to: removal is out of scope per ADR-0002, which
ADR-0005 now records as the settled reading, along with what that costs.

That decision does not rescue the spec's sentence about the root. Spec issue 2 justifies
`.claude/worktrees/` by a session-exit cleanup ADR-0005 reproduced and found does not reach these
worktrees, so an implementer reading the spec alone still reaches for that path expecting a behaviour
that is not there. The conclusion in the spec's harvest list and its Out of Scope section stands; the
reason attached to all three, and the root that reason picks, does not.
