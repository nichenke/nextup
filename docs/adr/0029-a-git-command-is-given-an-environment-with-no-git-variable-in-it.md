# A git command is given an environment with no GIT_ variable in it

Supersedes [0026](./0026-a-redirected-git-environment-is-refused-at-the-runner.md), which refused a run while
`GIT_DIR` or `GIT_COMMON_DIR` was set. That list was incomplete, the measurement behind it was taken against
one command, and four of its statements do not reproduce. All of it is corrected here rather than in 0026,
whose body stands as written.

## The decision

`defaultRunner` gives a git child `process.env` with every `GIT_`-prefixed name removed, whatever its value.
Nothing is refused, and no other command's environment is touched.

**By prefix, not by a list of the ones that redirect.** An enumerated list fails open: a variable nobody
measured is permitted, which is how this has now been wrong twice. Removing by prefix fails closed — a
variable nobody has measured is removed, and the cost of removing one that was harmless is nothing, because
nothing this tool runs needs a `GIT_` variable. That last clause is measured below rather than assumed.

**Only for git.** `gh`, `glab` and `jira` pass the same seam and authenticate from the environment, which is
why 0026 refused rather than stripped. Bun's `spawnSync` takes a per-call `env`, so that argument only ever
ruled out a *global* scrub; a git-only one leaves their credentials alone.

**Identified by the final path segment of `argv[0]`.** `command-builders.ts` writes a bare `git` in all eight
of its git commands, so matching that word alone would do today — but it is an enumeration of one, and an
absolute `/usr/bin/git` would have failed open exactly as the variable list did. The segment match costs
nothing to be wrong about: a program merely *named* `git` loses variables it does not read. It does not cover
git reached through another program — `env git`, `sudo git`, `sh -c "git …"` — or a wrapper under a different
name. None of those shapes exists in the tool, and this is the bound to widen if one is added.

**Reported once per run**, on stderr, naming every variable removed and saying that whatever they configured
went with them. It does not advise unsetting them, for the reason "Consequences" gives. Once per run rather
than once per name, because the environment does not change while the process lives, so the second call has
nothing new to name.

A removal is silent for names measured as changing no answer and exported by ordinary tooling — `GIT_EDITOR`,
`GIT_PAGER` — because a notice that fires on a harmless configuration is one its reader learns to skip. That
suppression is a second enumerated list, in a decision arguing against them, and it is worth naming as such:
what makes it safe is that it governs only the message. Removal is unconditional either way, so mis-listing a
name here costs a silent removal that was correct anyway and can never admit a redirect.

## The measurement

Against git 2.55, every command in `command-builders.ts` — the closed set of what this tool runs: the origin
read, `worktree list`, `show-ref`, `for-each-ref`, `rev-parse --git-common-dir`, the worktree identity
`rev-parse`, `symbolic-ref`, and `worktree add` — run against a repository named `<intended>` with each
variable pointing at `<other>`. Testing one command and generalising is the fault that produced 0026's list.

| Variable | What changed, at exit 0 |
| --- | --- |
| `GIT_DIR`, `GIT_COMMON_DIR` | origin read, `worktree list`, `--git-common-dir`, and `worktree add` all answered for `<other>`; the worktree it created went there |
| `GIT_WORK_TREE` | the identity `rev-parse` alone reported `<other>` as the worktree root |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` | the origin read returned `<other>`'s URL |
| `GIT_REPLACE_REF_BASE` | `worktree add` aborted on a `BUG:` assertion in git, exit 134 — no redirect, but a crash the tool would report as an ordinary failure |
| the other fourteen tried | no answer changed |

The fourteen: `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`,
`GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_COUNT` with `KEY_0`/`VALUE_0`, `GIT_LITERAL_PATHSPECS`,
`GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_EDITOR`, `GIT_PAGER`,
`GIT_TERMINAL_PROMPT`, `GIT_SSH_COMMAND`.

"No answer changed" is the whole claim, and for one of them it is narrower than it looks. The
`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` trio supplies arbitrary configuration, and configuration does reach these
commands: with `core.hooksPath` set that way, `worktree add` ran the `post-checkout` hook, and
`safe.directory` set that way reads back from `git config`. What it did not do was change any answer measured
above — `remote.origin.url` supplied through it left `git remote get-url origin` alone, and `core.worktree`
left the identity `rev-parse` alone. Removing the trio therefore costs something the table does not show,
which "Consequences" states.

With all of them exported at once and every `GIT_` name then removed, all eight commands returned exactly
their answers from a clean environment. That is what makes the keep-list empty: the removal takes nothing the
tool needs.

`GIT_WORK_TREE` is the case that shows why the method mattered. `worktree list --porcelain` resists it, and
that is the only command 0026 tried. It does not resist the identity `rev-parse`, whose ref half stays
correct — so `refuseUnlessOurs` gets a self-consistent wrong path beside a right ref, and blames the checkout
for an environment fault.

## What 0026 stated that does not hold

- **"`GIT_OBJECT_DIRECTORY` broke the command outright, which is already loud enough to need no guard."** It
  broke nothing. Every command in the set returned its correct answer at exit 0. The conclusion — no guard
  needed — held for the opposite reason.
- **"a wrapper, hook, or shell that exports it"** as the vector. git 2.55 hands a hook `GIT_AUTHOR_DATE`,
  `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_NAME`, `GIT_CONFIG_PARAMETERS`, `GIT_EDITOR`, `GIT_EXEC_PATH`,
  `GIT_INDEX_FILE` and `GIT_PREFIX` — not `GIT_DIR` or `GIT_COMMON_DIR`. The hook vector was real and the
  named variables were not the ones it produces, which is a second way an enumerated list misses.
- **"An injected runner is not checked, so tests are unaffected."** The same change added
  `src/test-preload.ts`, which stopped the whole suite before any test when either variable was exported.
  Tests were affected in the strongest available way. That half of the preload is removed here: the suite now
  passes with all five redirecting variables exported, which is the assertion the preload was standing in for.
- **"An empty value counts as unset, which is what a shell variable assigned but never exported leaves
  behind."** An unexported assignment reaches no environment at all — `sh -c 'GIT_DIR=/x; env | grep -c
  "^GIT_DIR"'` gives `0` — so there was nothing to carve out. `export GIT_DIR=` is the only way to observe
  `""`, and git does not read it as unset: a repository command fails with `not a git repository: ''` at 128,
  which this tool would have reported as a checkout that is not a git repository. Removing by prefix takes an
  empty value with the rest.

## Where else git is reached

The Runner is "the one place the tool touches anything outside itself" per `CONTEXT.md`, and two scripts sat
outside it.

`scripts/check-identifiers.sh` removes `GIT_` names itself, at the top. It cannot use the runner: `CLAUDE.md`
makes it run first in CI, before any dependency install, and that ordering is worth more than the single
seam. Left alone it was the worse bug of the two — `git ls-files` under a redirected `GIT_DIR` listed nothing
and the guard printed `ok`, so the repository's first check silently checked no files.

It also now refuses an empty listing rather than scanning one, because the redirect was a cause and not the
class. Both pipelines in that script end in `|| true`, so a failing `ls-files` is swallowed: run in a
directory that is not a repository at all, it printed `fatal: not a git repository`, then `ok`, and exited 0.
A checkout that produced no worktree or an image without `git` reaches the same place. The guard now fails
when nothing is tracked, which makes the `GIT_` removal above a second line of defence rather than the only
one.

`scripts/guard-harness.ts` spawns git raw to build a throwaway fixture repository. It asks `src/runner.ts`
for the scrubbed environment rather than owning a list. It hands the guard script the environment whole, on
purpose: whether the guard removes what it must is one of the things its tests assert.

## Consequences

A caller that supplies its own runner still supplies its own environment. The seam is the only thing that
scrubs, so an adapter reaching git another way is not covered — the two scripts above are the audited cases.

"Nothing the tool runs needs a `GIT_` variable" holds because every command in the set is a local read plus
`worktree add`. It is not a property of git. `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT` are
removed with the rest, and the first git command that talks to a remote — `fetch`, `clone`, `ls-remote`,
`push` — would meet that as a credential prompt or a hang against a private remote rather than as an error
naming this decision. Adding one means re-measuring, not assuming the table above still covers it.

The tool no longer refuses to start for an environment it can simply not pass on, so `debug-ref.ts` and any
scheduled run keep working in a redirected shell instead of exiting on an uncaught bare `Error`.

A `GIT_` variable a user set deliberately is ignored for git, not honoured and not fatal. Every command this
tool issues names the repository it means, so there is nothing for an ambient one to usefully *locate* — but a
variable can carry configuration rather than a location, and that is removed too. The case that matters is a
container running as a uid that does not own the checkout, where
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'` is how trust is granted when there
is no writable global config. Under 0026 that environment ran; here every command loses the grant and fails at
128 with `detected dubious ownership`, which this tool would report as a checkout it cannot read. It is a real
cost of the prefix rule and it is accepted rather than carved out: a keep-list for the trio would be the
enumerated list again, in the place hardest to reason about, since the trio can set *any* key. Nothing runs
that way today. The notice says what was removed and that its configuration went with it, and deliberately
does not advise unsetting — in this case the variable is the only reason git works.

`GIT_CONFIG_PARAMETERS`, which git exports to hooks, reaches `git config --get remote.origin.url` but not
`git remote get-url origin`, so it does not redirect the command this tool actually issues. It is removed
anyway.

## What the prefix does not cover

Anything that relocates git's discovery of its global config redirects the origin read without a `GIT_`
prefix. Two do, both measured on git 2.55 against `<intended>` while a real `~/.gitconfig` was present:
`HOME` pointing at a directory holding a `.gitconfig` that names another `origin`, and `XDG_CONFIG_HOME`
pointing at one holding `git/config`. Both made `git -C <intended> remote get-url origin` answer for
`<other>` at exit 0. This is the same wrong-ticket-set failure the decision above exists to prevent, reached
by a different door, and naming only the variables measured so far would repeat 0026's mistake at the level
of vectors rather than variables.

It is recorded rather than closed, because both fixes cost more than they buy and the choice belongs with
whoever wires the adapter:

- **`GIT_CONFIG_GLOBAL=/dev/null` in the environment this builds.** A positive assertion rather than another
  removal, and it closed both vectors in test. It also discards a legitimate global `safe.directory`, which
  is what makes git usable against a checkout owned by another uid — common in containers and CI images, and
  a failure that would look nothing like a config problem.
- **Reading `git config --local --get remote.origin.url` instead of `git remote get-url origin`.** It
  answered `<intended>` under both vectors. But `get-url` applies `url.<base>.insteadOf` rewriting and
  `--local` does not — measured: with an `insteadOf` rule in global config, `get-url` returned the rewritten
  URL and `--local` the one written in the repository. Which of those identifies the repository is a question
  about the tracker surface, not about this seam, so it is not settled here.
