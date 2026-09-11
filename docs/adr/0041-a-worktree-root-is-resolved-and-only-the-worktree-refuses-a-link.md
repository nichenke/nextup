# A worktree root is resolved, and only the worktree itself refuses a link

[ADR-0013](./0013-worktrees-go-under-the-primary-checkout.md) makes two promises that cannot both hold
on macOS. It promises a parametric absolute root — "`--worktree-root` takes an absolute path as given" —
and in the same breath forbids symlinks "along that path". `refuseIfReachedThroughLink` implemented the
second by walking every ancestor up to `/`. On macOS `/tmp`, `/var` and `/etc` are symlinks into
`/private`, and `$TMPDIR` lives under `/var/folders`, so every natural absolute root was refused, naming
a path the caller never typed. nichenke/nextup issue 39 raised it.

Three documents disagreed, not two. Ticket 10's acceptance criterion says "Symlinks refused at the root
and at the worktree itself", which is narrower than the walk and insufficient on its own: with `/tmp` a
symlink and the root `/tmp/trees`, neither `/tmp/trees` nor the worktree is a symlink, both checks pass,
and git still registers under `/private/tmp`.

## The decision

The container is **resolved**, the worktree **is not**.

`canonical` walks the root a segment at a time and resolves each, producing the spelling git registers
under. The worktree's own leaf keeps its refusal: `inspectUsable` `lstat`s it on both the attach and the
create route and turns away a symlink there, whatever the container resolved to.

That splits ADR-0013's rule where its own reason splits. 0013 objects to resolving because it "would
also accept a symlinked worktree, which nothing here needs" — an objection to resolving the *leaf*, which
this does not do. The hazard 0013 recorded is a container reached through a link: reproduced again here,
`git worktree add <R>/link/trees/x` with `<R>/link -> <R>/real` registers `<R>/real/trees/x`, the
caller's spelling never matches `registrations.find(one => one.path === path)`, and the next run reports
the branch checked out elsewhere instead of attaching. Resolving the container is the direct fix for
that: what `ensure` compares is now what git registers, and the refusal is no longer standing in for it.

Two guards get stronger for free, because both now compare the canonical container rather than the
spelling given: a root reaching the primary checkout through a link, and one reaching the git directory
through a link, are both refused where each previously depended on the link refusal to catch it.

## What a root still has to be

Issue 39 asks whether two other roots should join the refusals. Neither does.

- **Inside the checkout** — `--worktree-root src` leaves `?? src/` in the primary's status, outside the
  `.worktrees` ignore entry.
- **Outside it** — `--worktree-root ..` sites the worktree as a sibling of the primary checkout, which
  the title of ADR-0013 does not describe.

Both are accepted. The guards here exist to stop a *quiet* mismatch between the path this computes and
the path git registers; neither of these produces one, and both are visible to the caller in their own
`git status` or `git worktree list`. Refusing them would spend ADR-0013's "takes an absolute path as
given" on taste. The refusals that remain are the ones where the caller would otherwise be told something
untrue — a root that is the primary checkout, a root inside the git directory, a worktree that is a link
— plus a root the filesystem will not answer for at all.

## Resolution is not `realpathSync`

Handing the whole path to `realpathSync` produces a different answer than git for one shape, and it is
not a rare one. Bun 1.4.2 and Node both collapse a `..` lexically before resolving, so for
`<link>/..` they name the link's own parent; `realpath(3)` on macOS 25.4, Python's `os.path.realpath`,
and `git worktree add` all name the target's parent. Measured on all four rather than reasoned about.
Walking a segment at a time means `realpathSync` never sees a `..`, and the two agree.

Resolution stops at the first segment that is not there, because a root that does not exist yet is the
ordinary case. The remainder is appended with `join`, which collapses `.` and `..` among segments that do
not exist — which is what git does with the part of a path it could not resolve, confirmed the same way.

A segment the filesystem answers about with anything other than absence is refused rather than walked
past: a symlink to nothing, a loop, a file where a directory belongs. A dangling link is told apart from
a segment that does not exist yet by `lstat`, which still sees it — the distinction ADR-0013's note said
a whole-path comparison could not make.

## Consequences

ADR-0013's third bullet holds on macOS for the first time. Its symlink sentence is amended: read "at the
root and at the worktree itself" as "at the worktree itself", with the root resolved instead. Ticket 10's
acceptance criterion is superseded by this ADR for the same sentence; the deviation its author recorded
on issue 39 — leaving the ancestor walk in place rather than narrowing to the criterion — was the right
call and is now settled the other way round, by resolving rather than by refusing at all.

No caller is affected today. There is still no `--worktree-root` flag on the CLI and no tracker adapter
passing a root, so `ensure`'s default is the only path exercised — and the default was never refused,
because git hands back an already-resolved primary checkout to resolve it against. What changes is that
the flag, when it lands, can point where ADR-0013 said it could.
