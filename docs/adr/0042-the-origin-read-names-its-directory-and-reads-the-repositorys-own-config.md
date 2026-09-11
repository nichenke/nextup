# The origin read names its directory and reads the repository's own config

`git remote get-url origin` is replaced by
`git -C <directory> config -z --show-scope --includes --get-all remote.origin.url`, whose answer is filtered to
the scopes this checkout configures for itself.

The two halves reach [0029](./0029-a-git-command-is-given-an-environment-with-no-git-variable-in-it.md)
differently. Its "What the prefix does not cover" left the config source open, putting the choice with whoever
wired the adapter. The ambient directory it did not leave open: its Consequences defended the absence of a
`-C` — "asking 'which repository am I in' is its purpose" — so that half is a decision reversed rather than
one deferred. 0029 carries a banner saying so.

## The decision

**`config` rather than `remote get-url`.** `get-url` reads merged configuration, so a global file answers for
a repository the checkout is not, at exit 0, through two names the runner's `GIT_` scrub cannot reach.

**The scope boundary is the decision, and it is stated once.** In contract: `local` — `.git/config` and every
file it names, since an included value carries the including file's scope — and `worktree`, a linked
worktree's own `config.worktree`. Out of contract: `global`, `system`, and `command`. That line exists so a
later question about a scope has an answer here rather than a patch: what this refuses is configuration the
checkout never asked for, and an include or a worktree config is the checkout asking.

**`--show-scope` rather than `--local`.** Selecting `--local` reads one *file*, which is narrower than the
boundary above in two measured ways, and both were found one at a time by review after this decision first
shipped with `--local`:

| `.git/config` reaches origin via | `get-url` | `--local --get-all` | `--show-scope`, filtered |
| --- | --- | --- | --- |
| an ordinary `url =` | found | found | found |
| `[include]` or `[includeIf "gitdir:"]` | found | nothing, exit 1 | found |
| a linked worktree's `config.worktree`, with none in the common file | found | nothing, exit 1 | found |

Reading the label git already prints ends that sequence: a scope nobody has thought of yet is rejected by
default and admitted by one line here, rather than by discovering that `--local` did not cover it. Measured on
git 2.50.1 and 2.55, which is the span this had to hold across.

The safety property is what makes the wider read affordable, and it is unchanged. `--show-scope` labels the
ambient value rather than hiding it, and the filter drops it:

```
global      <other>      <- rejected
local       <intended>   <- taken
```

This is not a rule about repositories that configure nothing. A repository with a perfectly good local origin is
*still* answered for by an ambient one under `get-url`, because `remote.origin.url` is multi-valued and global
accumulates before local — measured on 2.50.1 and 2.55, with both set, `get-url` answers `<other>`. That is the
ordinary case, not an edge.

**`-z`, because otherwise the label can be forged.** A config value may contain a newline, and in the
line-oriented form only a value's first line carries its scope. A global value ending `\nlocal<tab><url>` is
printed across two lines, the second indistinguishable from a real `local` record — and the filter took it.
Measured on both versions, and it is this decision's own vector arriving through the parser rather than through
git. NUL-delimited, the forged text stays inside the value where it belongs. The one way an ambient
file is read is that `.git/config` names it in an `[include]`, which `get-url` did too — so the boundary costs
none of what this decision buys. It also newly rejects `command` scope, which `-c` and `GIT_CONFIG_PARAMETERS`
supply; the runner already strips the latter, so that is belt and braces rather than a second guard.

**`-C <directory>` rather than the ambient one.** This was the only one of the eight git commands the tool
builds that named no repository. The directory is now a value a caller supplies — `CliDeps.cwd` in a run,
`process.cwd()` in `scripts/reconstruct.ts` and in `resolveTicketRef`'s default.

**`--get-all`, taking the first value in contract.** A remote may carry several URLs. `get-url` answers with
the first and a bare `--get` with the *last*, so `--get` alone would have silently changed which URL identifies
a run's repository. Values arrive in scope order and, within a scope, in file order, so the first in a contract
scope is the first the checkout configures for itself.

That is deliberately *not* "the URL git fetches from", which is the first across every scope and so is the
global one whenever a global one exists. Answering differently is the decision; an earlier draft of this file
claimed the two were the same, which the row above disproves.

An empty value is skipped, because git drops empty URLs from a remote rather than fetching from them —
measured, `remote get-url --all` reports only the non-empty ones. This flip-flopped once: refusing shipped
briefly on the reasoning that skipping "answers with a URL the checkout does not fetch from", which is false
for exactly that reason. Both readings were asserted before they were measured; the measurement is what
settles it.

`--includes` is git's default with no scope selected, and is spelled anyway so the read does not change meaning
if that default does. It does not weaken what the allowlist leans on: every write flag is still rejected beside
`--get-all`.

## The measurement

git 2.55, against a repository whose own `origin` is `<intended>`, with a real `~/.gitconfig` present.
`<other>` is a second repository. Each vector set on its own.

| Vector | `remote get-url origin` | the scope-filtered read |
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
  `config --worktree` inside a linked worktree, `get-url` answered and `--local` reported nothing. This is one
  of the two shapes that moved the read off `--local`, and an earlier draft of this ADR said the opposite —
  that neither command saw the worktree value — from a fixture that wrote the URL into the common config *and*
  the worktree config, so `get-url` answered from the common one and the worktree scope was never exercised.
  The claim was wrong because the fixture could not have shown it either way.

## What it costs

`get-url` applies `url.<base>.insteadOf` rewriting and this read does not, and that cuts both ways. The two
shapes, measured:

- **A rewrite to a mirror**, where `<base>` is a real URL prefix. `get-url` answered with the mirror's host.
  That is a repository this tool would refuse as not being on GitHub, or — where the rewrite lands on another
  GitHub path — a different ticket set at exit 0. This read answered with the repository's own URL. This is
  the case the decision is right about.
- **A rewrite that expands an alias**, where the local URL is a bare word and a colon and an `insteadOf` rule
  is what makes it a URL at all. `get-url` answered with the expanded URL; this read answered with the alias,
  whose host is the bare word. This is the case the decision is wrong about, and it is a regression: a
  checkout configured that way worked before and is refused now.

  The rule's own scope does not matter, which is worth stating because the rest of this decision turns on
  scope. Measured with the `insteadOf` rule in the *repository's* config and `HOME` pointed at nothing:
  `get-url` still expanded it and this read still answered with the alias. Narrowing the scope decides where
  the URL is read from; it applies rewriting from nowhere, so "reads what the repository configured" is true
  of the value and not of the rewriting.

A third regression, narrower and measured: a repository that declares a local `[remote "origin"]` section
carrying no `url` — a bare fetch refspec, say — while the URL itself sits in global config. `get-url` answered
at exit 0; this read finds nothing in contract and the run refuses. An origin living *only* in global config is not part of
this: `get-url` already refused that, because it requires the remote to be configured in the repository.

It is accepted rather than closed, and the asymmetry is why. On the GitHub path this fails loud — the
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
cannot be enumerated in a prefix. Its entry is `git config -z --show-scope --includes --get-all`: `--get-all`
is what puts `git config` in a mode that cannot write, so it is part of the prefix rather than trailing detail.

`CliDeps.cwd` no longer carries an invariant that it must be where the process is standing. It is handed to
the origin read, so a `cwd` naming somewhere else moves the whole run there rather than splitting it — the
outcome its docstring named as the one to prevent.

0029's Consequences said "Almost every command this tool issues names the repository it means", with this
read as the exception. There is no exception now. The runner's removal notice is left as it stands anyway: the
fact a reader needs there is that `GIT_DIR` overrides `-C`, which is why naming the repository is not enough,
and the restored claim would lengthen the sentence without changing what anyone does about it.
