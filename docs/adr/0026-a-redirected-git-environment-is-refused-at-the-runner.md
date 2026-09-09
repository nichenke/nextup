# A redirected git environment is refused at the runner

`GIT_DIR` overrides `-C`. A wrapper, hook, or shell that exports it therefore points every git command this
tool issues at a different repository than the one it was asked about, and nothing downstream can notice,
because every answer git gives is self-consistent — about the wrong repository.

Reproduced against git 2.55: `git -C <intended> worktree list --porcelain` reports `<other>`, so `ensure()`
took `<other>` as its primary checkout, created the ticket's branch and worktree there, and returned
`created`. The same override reaches `resolveRepoFromOrigin`, which reads `git remote get-url origin` to
decide which repository's tickets a run considers — so the wrong *ticket set* arrives before the worktree
step is ever reached.

Which variables do this was measured, not taken from git's documentation. `GIT_DIR` and `GIT_COMMON_DIR`
redirect `git -C` silently. `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_NAMESPACE` and `GIT_CEILING_DIRECTORIES`
left it alone, and `GIT_OBJECT_DIRECTORY` broke the command outright, which is already loud enough to need no
guard.

## The decision

The two redirecting variables are refused, and the refusal lives in `defaultRunner`.

**Refused rather than stripped.** Stripping them from the child environment would fix git's aim, but this seam
also runs `gh`, `glab` and `jira`, and those authenticate from the environment — `GH_TOKEN`, proxy settings,
`HOME`. A scrub broad enough to be safe would break their credentials, and one narrow enough to be safe is a
list that has to stay in step with git. Refusing needs neither.

**At the runner rather than in the CLI**, because `CONTEXT.md` makes the Runner "the one place the tool touches
anything outside itself". A check in `cli.ts` would be a layering violation and could be bypassed by any
caller that reaches the runner another way; a check at the seam cannot.

**Loudly, on every call, and that is accepted.** The failure is an uncaught throw naming the variable and
saying to unset it. The alternative it replaces is a run that reads another repository's tickets, writes a
branch into it, and reports success.

## Consequences

An injected runner is not checked, so tests are unaffected and a caller that supplies its own runner takes
responsibility for its own environment.

`--help` still works with the variable set, because it invokes no external command. The refusal fires when git
would actually run, not when the process starts.

An empty value counts as unset, which is what a shell variable assigned but never exported leaves behind.

This is not the same decision as [0025](./0025-a-repository-whose-git-directory-moved-is-turned-away.md).
That one turns away a repository whose git directory is genuinely elsewhere — `--separate-git-dir`, or a
submodule — by reading where the repository keeps its administration. This one refuses an *environment* that
lies about which repository is being addressed at all, which no inspection of a repository can detect.
