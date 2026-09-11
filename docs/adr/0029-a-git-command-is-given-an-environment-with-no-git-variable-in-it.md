# A git command is given an environment with no GIT_ variable in it

Supersedes [0026](./0026-a-redirected-git-environment-is-refused-at-the-runner.md), which refused a run while
`GIT_DIR` or `GIT_COMMON_DIR` was set. That list was incomplete, the measurement behind it was taken against
one command, and four of its statements do not reproduce. All of it is corrected here rather than in 0026,
whose body stands as written.

## The decision

`defaultRunner` gives a git child `process.env` with every `GIT_`-prefixed name removed, whatever its value.
Nothing is refused. Another command's environment is passed on whole, though still constructed rather than
inherited, for the reason two paragraphs below.

**By prefix, not by a list of the ones that redirect.** An enumerated list fails open: a variable nobody
measured is permitted, which is how this has now been wrong twice. Removing by prefix fails closed against
*redirection* — a variable nobody has measured cannot point git anywhere, because it is not there.

It does not fail closed against the loss of what a variable was doing, and two shapes of that are real. A
variable can carry configuration, which "Consequences" covers. A variable can also *suppress* configuration:
`GIT_CONFIG_GLOBAL=/dev/null` is how a caller runs git hermetically, and removing it hands `~/.gitconfig` back,
where a `url.<base>.insteadOf` rule rewrites the origin read — measured, turning an origin of `<intended>` into
one under a different host. The prefix rule is the right trade anyway, because the alternative is the
enumerated list that has now been wrong twice, but "fails closed" is a claim about location and not about
configuration.

**Only for git.** `gh`, `glab` and `jira` pass the same seam and authenticate from the environment, which is
why 0026 refused rather than stripped. Bun's `spawnSync` takes a per-call `env`, so that argument only ever
ruled out a *global* scrub; a git-only one leaves their credentials alone.

Every child is given a constructed environment, not an inherited one, so `argv[0]` decides only which names
are removed. Inheriting for the others would also have made it decide *when* the environment was read: Bun
hands an inherited child the environment as it stood at startup, so a variable assigned since would reach a
git child and not a `gh` one — an asymmetry no reader of `Runner` could predict from its signature.

**Identified by the final path segment of `argv[0]`.** `command-builders.ts` writes a bare `git` in all eight
of its git commands, so matching that word alone would do today — but it is an enumeration of one, and an
absolute `/usr/bin/git` would have failed open exactly as the variable list did. The segment match costs
nothing to be wrong about: a program merely *named* `git` loses variables it does not read. It does not cover
git reached through another program — `env git`, `sudo git`, `sh -c "git …"` — or a wrapper under a different
name. None of those shapes exists in the tool, and this is the bound to widen if one is added.

**Reported once per run**, on stderr, naming the variables removed — bar the two suppressed below — and saying
that whatever they configured went with them. It does not advise unsetting them, for the reason "Consequences" gives. Once per run rather
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
variable set to `<other>`, or to the value the table gives. Testing one command and generalising is the
fault that produced 0026's list.

| Variable | What changed |
| --- | --- |
| `GIT_DIR`, `GIT_COMMON_DIR` | at exit 0: origin read, `worktree list`, `--git-common-dir`, and `worktree add` all answered for `<other>`; the worktree it created went there |
| `GIT_WORK_TREE` | at exit 0: the identity `rev-parse` alone reported `<other>` as the worktree root |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` | at exit 0: the origin read returned `<other>`'s URL |
| `GIT_REPLACE_REF_BASE=refs/other` | no redirect, but `worktree add` died on `BUG: refs.c:1900: ref pattern must end in a trailing slash when trimming`, SIGABRT. The missing slash is the whole cause: `refs/other/` exits 0, so a reader who writes the namespace the conventional way reproduces nothing. The runner turns a signalled death into 128 plus the signal number, which is the 134 a shell shows |
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
- **"a wrapper, hook, or shell that exports it"** as the vector. git 2.55 hands a `post-commit` hook
  `GIT_AUTHOR_DATE`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_NAME`, `GIT_CONFIG_PARAMETERS`, `GIT_EDITOR`,
  `GIT_EXEC_PATH`, `GIT_INDEX_FILE` and `GIT_PREFIX` — not `GIT_DIR` or `GIT_COMMON_DIR`. One hook, named
  rather than generalised: the set differs per hook, and "a hook receives X" from a single measurement is the
  move this ADR faults 0026 for. What holds for the argument is only that this hook does not export the two
  variables 0026 refused, so the hook vector was real and did not produce them.
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

It also now refuses to report on a scan that saw less than the tree, because the redirect was a cause and not
the class. Both pipelines in that script end in `|| true`, so anything leaving them without input reads as
nothing found: run in a directory that is not a repository at all, it printed `fatal: not a git repository`,
then `ok`, and exited 0. Each cause is now told apart, with its own message, because "the repository is
empty" and "git is broken" are not the same report:

- `git ls-files` failing at all, which is where a redirected environment, a missing `git`, or a checkout that
  produced no worktree lands. Reported as a listing failure rather than as a claim about the contents — under
  `CLAUDE.md`'s ordering this step runs before any dependency install, so a broken image reaches it first.
- nothing tracked, where a pass would mean nothing.
- a sparse checkout, where `ls-files` counts a tracked file that is not in the worktree and `grep` skips it, so
  the guard passed on the subset that was materialised — measured with the identifier in the excluded file.
  Denied rather than reported on: nothing in this repository needs one, and CI takes the whole tree. Asked of
  `core.sparseCheckout` rather than inferred from a file being absent, because an unstaged deletion looks
  identical on disk and refusing that would refuse an everyday tree; a file merely deleted is scanned as the
  absence it is, which `ADR-0006`'s "the files as they stood when it ran" already scopes.
- a tracked file the scan cannot open, which it skips exactly as it skips an absent one. A mode-000 file
  holding an identifier passed, and so did one under a mode-000 *directory*. Both measured.

Before any of that, the scan starts at the repository root rather than wherever it was invoked. `git ls-files`
lists what is under the current directory, so a run from a subdirectory scanned that subtree and reported a
pass — 43 of this repository's 209 tracked files, measured from `docs/` at the time of writing. CI and the
package script both happen to run at the root, so what this closes is a direct invocation by a person or an
agent. It is a correction rather than a refusal because `rev-parse --show-toplevel` either answers or there is
no worktree to scan: in a bare repository it exits 128, no `cd` happens, and `git ls-files` then exits 0 with
nothing, which lands on the nothing-tracked refusal above. Measured.

The property is that the scan read every tracked file it could have, and it took three attempts to state it
without a hole, which is worth recording as its own lesson. `xargs -0 ls` answered "is the path there", not
"can it be read", so a mode-000 file passed. `[ -e ] && [ ! -r ]` answered readability but cannot see through
an unreadable directory, so a path behind one read as absent and was tolerated — the branch deliberately left
open for an unstaged deletion. Each fix closed the case it was shown and left the sibling of the same property.

It is now asked as two questions, because no single test answers both, and git does the classifying rather
than a predicate standing in for it. The streams are not a partition and it matters that they are not: a path
git cannot lstat appears on stdout *and* stderr, while a genuine deletion appears on stdout alone, and the
command exits 0 either way. Measured. So the diagnostic decides, and it has to be the diagnostic belonging to
the listing that is used: a listing taken without it puts an unstattable path into the deleted set, where it
is tolerated as an everyday deletion and never scanned. What remains after that is a path git could stat,
where `[ -r ]` is the whole question — a mode-000 file reaches neither the error nor the deleted list.

A draft of this ran the two as separate invocations — one to probe stderr, a second to take the listing — and
that is a race rather than a shortcut. Anything breaking the tree between the two leaves the probe clean and
the consumed listing carrying a path it could not stat, on a call whose stderr nothing read. It is one call
now, with stdout and stderr captured and both checked. The general lesson is worth more than the instance:
a check and the thing it licenses have to come from the same observation, or the gap between them is a window.

The stderr test cannot say *why* git complained, so it does not try. A broken `core.fsmonitor` writes there
too, and both it and an unreadable path exit 0, so the guard prints git's own text verbatim and then refuses
without naming a cause. Measured. That is a departure from the one-message-per-cause rule above, and the
honest one: the two causes are indistinguishable at this point, and both are reasons to refuse.

A tracked symlink is neither refused nor followed: its target is read with `readlink` and scanned alongside
the file contents. git commits the target path as the blob, and `grep` follows the link and reads whatever it
points at instead, so the target text is tracked content the scan never saw. Measured — a link to `<host>/x`
whose target existed committed that host as a blob and the guard printed `ok`, exit 0.

An earlier draft refused only the *dangling* case, because `[ -r ]` is false for one, and called that
deliberate. It was not: the property belongs to every symlink, and the subset that happens to fail a
readability test is not the subset that carries unscanned text. Refusing the dangling one and passing the
resolving one closed the shape that was noticed and left the shape that mattered — the same fault the three
attempts above record. Reading the target covers both, and removes a refusal rather than adding one.

Reading the target is only half of it: the link must also leave the list the scan reads, or `grep` follows it
anyway. A draft that read targets and left the links in place made the guard fail on the contents of an
*untracked* file, under a message asserting a tracked file held it and naming no path, and hang forever on a
link whose target was a FIFO — `timeout` reported 124, which in CI is a hung job rather than a failed one.
Both measured. The scan now reads a list built during the walk, holding the paths it may open and nothing
else.

Two comparisons in that walk are byte comparisons, and one of them was not. `git ls-files --deleted` without
`-z` applies `core.quotePath`, returning `"caf\303\251.md"` where the tracked listing gives the bytes, so no
path holding a non-ASCII character, a quote or a backslash ever matched — and deleting one without staging it
was refused as unreadable, which is precisely the everyday tree the deleted branch exists to keep scanning.
Measured. Both listings are now `-z` and compared whole.

A deleted path is also kept out of the scan list rather than merely exempted from the refusal, because the
scan now treats any `grep` diagnostic as fatal and a missing file produces one.

That last rule is the answer to a question the checks above cannot settle on their own: they all run *before*
the scan, so a file that stopped being readable in between — a concurrent checkout, a rewrite, a mode change —
was skipped with its error sent to `/dev/null` and its status eaten by `|| true`. The exit status cannot
carry it, because `grep` exits 1 for "no match", which is the ordinary result here. Its stderr is kept instead,
and anything on it refuses.

Finally, `set -e` made two of these refusals silent. A bare `v=$(cmd)` takes the substitution's status, so a
failing git exited the script *before* the `if` meant to report it, with git's stderr captured into the
variable and never printed — a refusal with no output at all. Measured. Each such capture is now written as
`if ! v=$(cmd)` with its own message.

Separately, the scan now passes `--` to `grep`. A tracked filename may begin with a hyphen, and `git ls-files`
happily reports one: with a file named `-d`, BSD `grep` rejected its own argument list, `2>/dev/null` ate the
error, `|| true` ate the status, and the guard printed `ok` over the identifier inside it. Measured. This is
older than the work here, but a change claiming whole-tree coverage owns it.

`--` does not rescue every such name, and the one it leaves is refused rather than scanned. `grep` reads a
file named exactly `-` as standard input even after `--`, so its contents never reached the scan and the guard
printed `ok` over the identifier in it. Measured, with the fixed `--` in place.

Last of the same class, and the one that made the others' coverage claim false: `git ls-files -z` piped
straight into a reader discards its exit status, so a listing that failed part way through arrived as fewer
paths and read as nothing found — `ok` over a tracked identifier, measured with a git that fails only that
call. The listing is now written once to a temporary file whose status is checked, and both the per-path loop
and the scan read it. A command substitution cannot hold it instead: bash strips NUL from one, which is the
separation `xargs -0` depends on.

It is refused on cost, not because scanning it is impossible — the distinction is worth stating, because a
reader who tries the alternative will find it works. Prefixing every path with `./` scans it, and the
one-liners that would do the prefixing do not survive NUL separation: macOS `awk` truncates at the first NUL
and BSD `sed` has no `-z`, both measured. What does work is a second NUL-safe reader in the scan's hot path,
in the same idiom as the loop above. That is the price, and a filename nothing here needs does not justify it.

Together these make the `GIT_` removal above a second line of defence rather than the only one.

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

A `GIT_` variable a user set deliberately is ignored for git, not honoured and not fatal. Almost every command
this tool issues names the repository it means, so there is little for an ambient one to usefully *locate*.
The exception is the origin read, `git remote get-url origin`, which carries no `-C` and so resolves from the
current directory: asking "which repository am I in" is its purpose, and a scrubbed environment makes the
answer the directory rather than an inherited variable. Under 0026 the same situation threw instead. (0041
gave that read a `-C` too, so there is no exception left.)

A variable can also carry configuration rather than a location, and that is removed too. The case that matters
is a checkout owned by another uid, where
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=<path>` is how trust is granted when
there is no writable global config. Measured against a repository owned by another user on this machine: with
the grant, `rev-parse --show-toplevel` answers; with the same grant through this runner, 128 and
`fatal: detected dubious ownership`, which the tool reports as a checkout it cannot read. Under 0026 that
environment ran.

It is a real cost of the prefix rule and it is accepted rather than carved out: a keep-list for the trio would
be the enumerated list again, in the place hardest to reason about, since the trio can set *any* key. The
recovery is `git config --global --add safe.directory <path>`, which nothing here strips, because `HOME` carries
no `GIT_` prefix. The notice says what was removed and that its configuration went with it, and deliberately
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

Both were closed afterwards, by a corrected form of the second option below — it takes `--get-all` rather than
the `--get` spelled there, which answers with the wrong value where a remote carries several.
[0041](./0041-the-origin-read-names-its-directory-and-reads-the-repositorys-own-config.md) has that and the
question this leaves open at the end. What follows is the reasoning as it stood here:

- **`GIT_CONFIG_GLOBAL=/dev/null` in the environment this builds.** A positive assertion rather than another
  removal, and it closed both vectors in test. It also discards a legitimate global `safe.directory`, which
  is what makes git usable against a checkout owned by another uid — common in containers and CI images, and
  a failure that would look nothing like a config problem.
- **Reading `git config --local --get remote.origin.url` instead of `git remote get-url origin`.** It
  answered `<intended>` under both vectors. But `get-url` applies `url.<base>.insteadOf` rewriting and
  `--local` does not — measured: with an `insteadOf` rule in global config, `get-url` returned the rewritten
  URL and `--local` the one written in the repository. Which of those identifies the repository is a question
  about the tracker surface, not about this seam, so it is not settled here.
