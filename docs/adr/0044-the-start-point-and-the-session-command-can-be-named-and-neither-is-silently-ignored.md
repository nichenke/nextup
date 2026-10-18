# The start point and the session command can be named, and neither is silently ignored

nichenke/nextup issue 92 adds two flags for a stack orchestrator, which delivers a multi-phase spec as a
linear stack of pull requests, one phase ticket each. It starts every phase with an override and `--force`,
because phase N+1 starts while phase N is still open and so still its blocker. `--base <ref>` names where a
new branch starts, and `--command <template>` names what the workspace runs. Both work on the ranked and the
named path, with `--force`, and with `--print-command`.

## Where a new branch starts

Without a base, Ensure cuts a new branch from the primary checkout's HEAD. `worktreeAddCommand` passes git
no start point, so the branch inherits whatever the primary has checked out, and the default branch plays no
part in where it starts. That inheritance is the only reason `driftWarnings` exists. It reports a primary that has drifted off the default
branch, because a branch cut there carries the drift. A stacked phase needs its branch cut from its parent
phase's branch instead, and with `--base` Ensure passes the base to git as the start point.

The workaround was to pre-create the branch outside nextup and let Ensure attach to it. That was rejected
because it copies `branchName` into another process. Any disagreement between the two copies, such as a
retitled ticket, an added bug label or a change to the slug rule, sends Ensure looking for a name nobody
created, and it silently cuts a fresh branch from the primary's HEAD.

**The base is resolved where the command was typed**, in `deps.cwd`, not in the primary checkout that
Ensure runs git against. A ref on a command line means what it means where it was typed, and `HEAD` in a
linked worktree is that worktree's HEAD rather than the primary's.

**It is pinned to a full commit id before anything is written.** `resolveBase` runs
`git rev-parse --verify --quiet --end-of-options '<ref>^{commit}'` and keeps the ref as typed beside the
commit it named. It runs before the host ping, the confirmation gate, Ensure and the claim, so a base that
does not resolve is a refusal that has written nothing, for the reason
[0035](./0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md) gives, and
nobody is asked to approve a start that cannot happen. It runs on the `--print-command` path too, so a
preview refuses what a start would. Pinning also means that:

- the commit git cuts from is the one resolved, even if the ref moves before `git worktree add` runs;
- the start point git receives is an object id, which no spelling of the ref can turn into an option;
- the new branch gets no upstream, measured on git 2.56.

The refusal is typed like every other Ensure refusal, as `WorktreeError` kind `unresolvable-base`. That kind
covers three cases:

- a blank ref;
- git's exit 1, which is git answering that the ref names no commit;
- an exit 0 whose answer is not exactly one full object id.

The third case is real. Measured on git 2.56, `^side` exits 0 and prints `^<id>`, because rev-parse reads it
as an exclusion, and without the check that string would reach `git worktree add` as the start point.

Any other nonzero exit, such as 128 outside a repository, and an exit 0 that printed nothing are kind `git`,
because there the repository failed rather than answered. The split goes by what git returned rather than
by whose fault it was, so it misfiles one case. A reflog entry past the log's end, such as `main@{99}`, exits
128 under `--quiet` and is reported as `git`, though the ref is what is wrong.

**With a base applied, the drift warning is dropped.** The new branch did not inherit the primary's HEAD, so
a warning about what that HEAD is on describes a risk the run did not take. Without `--base`, the start point
and the warning are both unchanged. In place of the warning, the rendering names the base and the commit it
was pinned to, as in this line:

```
  on <branch>, a new branch from <given> at <7-char commit>
```

## A base that cannot apply is reported as not applied

A base means something only when Ensure creates the branch. When the branch already exists, locally or on
origin, or a worktree for it is already registered, Ensure attaches or checks it out as before and leaves
the branch where it is. Two other answers were available, and both were rejected.

- **Ignoring the base silently** is how a stack ends up on the wrong parent. The orchestrator asked for phase
  N+1 on top of phase N, a branch left from an earlier attempt sits on something else, and a run that says
  nothing reports success for a stack other than the one requested.
- **Moving the branch onto the base** rebases or resets a branch that may carry work, a destructive step this
  tool has no basis to take. The orchestrator owns stack topology, and rebasing or retargeting an existing
  branch is out of scope here.

So the run attaches and says so. The human rendering adds a line a caller can find with `grep '^warning: '`,
as in this example:

```
warning: --base <given> was not applied: <branch> already existed, so it was left where it was
```

`--json` carries the same fact as `start.worktree.base` with `kind: "not-applied"`, so the orchestrator can
stop on a field rather than on a string match.

The outcome type makes the wrong report unrepresentable rather than tested. `BaseOutcome` is `none`,
`applied` or `not-applied`. The `created` arm carries only `none` or `applied`, and the `attached` and
`checked-out` arms carry only `none` or `not-applied`, so an applied base on a branch that already existed
does not typecheck, and neither does a base not applied to a branch just created.
[0039](./0039-enterprise-is-out-of-scope-and-out-of-scope-means-unrepresentable.md) is the precedent for
putting such a rule in the type.

## What the workspace runs

`--command <template>` runs the template in place of `claude "<slash-command> <ref>"`, with every `{ref}` in
it replaced by the ticket's reference. The orchestrator's phase worker is a wrapper script run inside tmux,
which no slash command can name.

**The template is split on whitespace and each word quoted through `formatCommand`**, the path the default
command takes. The workspace host takes a line rather than argv and types it into a shell, so since
[0035](./0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md) that quoting is
what stands between a word and shell syntax. Quoting each word keeps the guarantee for a template. `$` and
`;` reach the program as themselves, and a reference substituted into a word stays inside it. Accepting the
template verbatim as a shell string was rejected, because it would splice the reference into shell code and
hand the host a line nothing here had quoted.

**A word carrying `'`, `"` or `\` is refused.** Each signals quoting the author expected a shell to remove,
and under per-word quoting it would arrive literal instead, so `run 'a b' {ref}` would pass `'a` and `b'` as
two words. A refusal beats running something other than what was written. The cost is that a template cannot
pass an argument containing a space or expand a variable, since `$HOME` arrives as `$HOME`. Anything needing
the shell belongs in the script the template runs.

**`{ref}` is required.** The session's whole task is the reference. A template without it would start a
session that does not know its ticket, in a worktree made for that ticket, with the ticket claimed.

**`--command` with `--slash-command` is refused**, as a usage error naming both. The slash command means
something only inside the default command, so beside a template it would be dropped, and the two would
disagree with nothing saying so. This is the rule the base follows too: a flag that would change nothing is
reported rather than dropped.

## What a template run claims

[0036](./0036-the-launcher-reports-a-request-not-a-running-session.md) checks the session binary with
`claude --version` before anything is written. A template run skips that probe, because the template's
program is not the session binary and `--version` is no contract an arbitrary program honours. A wrapper
script may reject the flag, do its work regardless of it, or exit nonzero for reasons unrelated to whether
it runs. The host probe still runs.

So nothing catches a template whose program is missing or broken before the worktree and the claim land, and
the run still reports `requested`. The word stays honest, because 0036 chose it to mean that the host
accepted the request and no more. A wrapper that wants its own failure seen has to report it; this tool
cannot tell.

## Consequences

`--json` carries `start.command` as the templated argv and `start.worktree.base` as the `BaseOutcome`. A
`Base` and `CommandTemplate` are classes with a private constructor and a `#` field, so only
`resolveBase` and `parseCommandTemplate` make them. A symbol brand, the pattern `CheckoutIdentity` uses, was
rejected for both, because a spread copies it, so `{ ...base, commit }` would pass for a base carrying a commit
git never named. JSON shows a base as `{ given, commit }`.

`--print-command` with a named ticket runs one local git command when `--base` is given.
[0037](./0037-naming-a-ticket-skips-the-ranking-and-nothing-else.md)'s sandbox-safe property holds, since
it reads no tracker and needs no network, but the path now reads the checkout once more than 0037 lists.

Neither flag changes the write order or what `--force` clears. Worktree, claim, session stays the order
[0016](./0016-the-worktree-is-created-before-the-claim.md) and 0037 fixed.

The selector and the ranking ladder learn nothing about stacks, which is out of scope. A phase blocked by
its parent stays blocked to the ladder, and the orchestrator reaches it through an override and `--force`.
