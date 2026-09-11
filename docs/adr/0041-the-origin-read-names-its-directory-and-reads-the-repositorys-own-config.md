# The origin read names its directory and reads the repository's own config

`git remote get-url origin` is replaced by `git -C <directory> config --local --get-all remote.origin.url`.

The two halves reach 0029 differently.
[0029](./0029-a-git-command-is-given-an-environment-with-no-git-variable-in-it.md)'s "What the prefix does not
cover" left the config source open, putting the choice with whoever wired the adapter, and named
`config --local --get` as one of two candidates. The ambient directory it did not leave open: its Consequences
defended the absence of a `-C` — "asking 'which repository am I in' is its purpose" — so that half is a
decision reversed rather than one deferred. The `--get` spelling is corrected here too.

## The decision

**`config --local` rather than `remote get-url`.** `get-url` reads merged configuration, so a global file
answers for a repository the checkout is not, at exit 0, through two names the runner's `GIT_` scrub cannot
reach. `--local` reads the repository's own config file and no other.

**`-C <directory>` rather than the ambient one.** This was the only one of the eight git commands the tool
builds that named no repository. The directory is now a value a caller supplies — `CliDeps.cwd` in a run,
`process.cwd()` in `scripts/reconstruct.ts` and in `resolveTicketRef`'s default.

**`--get-all`, taking the first value.** A remote may carry several URLs. `get-url` answers with the first and
a bare `--get` with the *last*, so `--get` alone would have silently changed which URL identifies a run's
repository. git fetches from the first.

## The measurement

git 2.55, against a repository whose own `origin` is `<intended>`, with a real `~/.gitconfig` present.
`<other>` is a second repository. Each vector set on its own.

| Vector | `remote get-url origin` | `config --local --get-all remote.origin.url` |
| --- | --- | --- |
| clean | `<intended>` | `<intended>` |
| `GIT_DIR`, `GIT_COMMON_DIR` | `<other>` | `<other>` |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` | `<other>` | `<intended>` |
| `HOME` holding a `.gitconfig` naming another origin | `<other>` | `<intended>` |
| `XDG_CONFIG_HOME` holding `git/config` naming another origin | `<other>` | `<intended>` |
| `GIT_WORK_TREE`, the `GIT_CONFIG_COUNT` trio | `<intended>` | `<intended>` |

Every one of those is exit 0. `GIT_DIR` and `GIT_COMMON_DIR` still redirect, so the scrub stays load-bearing
and this closes nothing it was closing; what it adds is the four rows the scrub cannot reach, two of which
carry no `GIT_` prefix at all and so were open by construction.

Two further readings, measured the same way:

- **Several URLs on one remote.** `get-url` → the first; `config --get` → the last; `config --get-all` → both,
  in file order, first first.
- **A per-worktree override.** With `extensions.worktreeConfig` set and `remote.origin.url` written through
  `config --worktree` inside a linked worktree, neither `get-url` nor `--local` reported it; only a merged
  `git config --get` did. So reading from a worktree is not where the two commands part.

## What it costs

`get-url` applies `url.<base>.insteadOf` rewriting and `--local` does not, and that cuts both ways. The two
shapes, measured:

- **A rewrite to a mirror**, where `<base>` is a real URL prefix. `get-url` answered with the mirror's host.
  That is a repository this tool would refuse as not being on GitHub, or — where the rewrite lands on another
  GitHub path — a different ticket set at exit 0. `--local` answered with the repository's own URL. This is
  the case the decision is right about.
- **A rewrite that expands an alias**, where the local URL is a bare word and a colon and only a global rule
  makes it a URL at all. `get-url` answered with the expanded URL; `--local` answered with the alias, whose
  host is the bare word. This is the case the decision is wrong about, and it is a regression: a checkout
  configured that way worked before and is refused now.

A third regression, narrower and measured: a repository that declares a local `[remote "origin"]` section
carrying no `url` — a bare fetch refspec, say — while the URL itself sits in global config. `get-url` answered
at exit 0; `--local` finds nothing and the run refuses. An origin living *only* in global config is not part of
this: `get-url` already refused that, because it requires the remote to be configured in the repository.

It is accepted rather than closed, and the asymmetry is why. On the GitHub path `--local` fails loud — the
alias cannot pass the host test, so the run stops and says what it read. `get-url` fails silently in the mirror case and in
both config-location rows above, which is the wrong-ticket-set failure
[0026](./0026-a-redirected-git-environment-is-refused-at-the-runner.md) exists for. A loud refusal on a
configuration a minority uses is a smaller cost than a silent answer about the wrong repository.

The refusal says so rather than leaving a host nobody configured unexplained: where the host carries no dot,
the message names `url.<base>.insteadOf` and says this reads the URL the repository's own config spells. The
dot catches the bare-word idiom and nothing more — git accepts a dotted `insteadOf` base too, measured, and
that one arrives unexplained. It costs nothing to be wrong about, because it appends a sentence to a refusal
rather than deciding one.

`resolveCheckoutRepoPath`, the bare `glab:<number>` reading, has no host test to fail loud at, and cannot
gain one: `git@gitlab:group/project` is a legitimate short hostname and `work:group/project` an alias, and
nothing in the URL tells them apart. Measured, what survives there is narrow — an alias whose base absorbs a
namespace segment leaves a one-segment path, which `gitlabTicketRef` refuses, so a wrong answer needs an alias
that absorbs a namespace *and* a local path still carrying two segments. Both shapes are pinned in
`checkout-identity.test.ts`. It is bounded further by GitLab having no adapter: such a path can reach a
refusal message, not a ticket set.

Reading both and comparing was considered and not taken. It doubles the read, and the disagreement it would
have to arbitrate is exactly the alias case — where refusing is what this already does, one command sooner.

## What else moved

`readOnlyRunner` matches its allowlist after skipping a leading `git -C <directory>`, because a directory
cannot be enumerated in a prefix. Its entry is `git config --local --get-all`: `--get-all` is what puts
`git config` in a mode that cannot write, so it is part of the prefix rather than trailing detail.

`CliDeps.cwd` no longer carries an invariant that it must be where the process is standing. It is handed to
the origin read, so a `cwd` naming somewhere else moves the whole run there rather than splitting it — the
outcome its docstring named as the one to prevent.

0029's Consequences said "Almost every command this tool issues names the repository it means", with this
read as the exception. There is no exception now. The runner's removal notice is left as it stands anyway: the
fact a reader needs there is that `GIT_DIR` overrides `-C`, which is why naming the repository is not enough,
and the restored claim would lengthen the sentence without changing what anyone does about it.
