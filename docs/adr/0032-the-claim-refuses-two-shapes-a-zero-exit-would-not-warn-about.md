# The claim refuses two shapes a zero exit would not warn about

The claim is one write and its exit status is the whole verdict, per
[0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md). Nothing is read back, so there is no second
observation to catch a write that went somewhere else or did not happen. That puts the entire weight of the
step on one number, and two inputs make that number lie. Both are refused before the call.

## A reference whose host is not GitHub's

> **Relocated by [0039](./0039-enterprise-is-out-of-scope-and-out-of-scope-means-unrepresentable.md).**
> This section and the renumbered-key one below describe hazards that are unchanged, and the argv guards
> they put in place are still there. What moved is where each is *stopped*: a GitHub reference can no
> longer carry a host at all, and a padded key can no longer be built, so neither shape reaches the claim
> to be refused. The "two existing checks" named below are two of five that 0038 collapses, and the
> remark that `resolveTicketRef` still accepts `#037` is no longer true. Three other statements have gone
> stale with it: the guard now raises `TicketRefError` rather than `CommandBuilderError`, so the
> requirement below that the launcher "let a `CommandBuilderError` through" names the wrong class;
> "Nothing calls the claim yet" is no longer so; and `claimGitHubTicket` no longer checks the repository
> path itself, the type having done it. Amended, not superseded — the `GH_HOST` refusal, the measurements,
> and everything about what `gh` does with a bare path describe the current tool.

`gh issue edit --repo owner/repo` carries no host, so the write addresses whatever host `gh` treats as
default. A reference parsed from a pasted GitHub Enterprise URL keeps its host, and `resolveTicketRef` accepts
it once `gh` reports itself authenticated there — so a ticket that legitimately exists on an enterprise
instance can reach the claim. Claiming it would assign an unrelated repository sitting at the same
owner-and-repository path on GitHub, and exit 0.

This is the only place a reference's *own* host is compared against GitHub's. The two existing checks —
`requireGitHubOrigin` in the read adapter, and the short-form branch of `resolveTicketRef` — both compare a git
remote's host, and both fire only when the repository was resolved from that remote. `GitHubReadInput` has no
host field at all, so a read handed an explicit `owner/repo` never receives a host to judge — it is not that the
read refuses the mismatch more leniently, it is that the mismatch cannot reach it. There is no precedent here to
lean on, which is why the reasoning is written out rather than cited.

An absent host is accepted, and is the ordinary case: every reference the read adapter emits sets it to null,
because the repository came from the query rather than from a URL.

### The environment can still redirect, so the environment is refused

Accepting an absent host is what leaves a gap, and review found it: `gh` reads `--repo` as `[HOST/]OWNER/REPO` and
falls back to `GH_HOST` when the host is left off, so *where* a bare path goes is decided by the environment rather
than by the reference. Measured on gh 2.100.0 with `GH_HOST` set to a name that cannot resolve, a bare `owner/repo`
tried to reach that name. Nothing upstream removes it: `defaultRunner` scrubs only `GIT_`-prefixed names, and only
for git, which ADR-0029 bounds deliberately because `gh` authenticates from the environment.

`defaultRunner` therefore refuses any `gh` command while `GH_HOST` is set, and `refuseRedirectedGitHub` is where.
Two designs were tried and this is the second:

The first put GitHub's host in front of the repository at the point of the claim. It worked, and it was wrong at
this altitude. Because `gh` resolves a *bare* path against the environment, safety then belongs to whichever call
sites remember to qualify — and review immediately found the next one: a capture run under a redirecting `GH_HOST`
would read the write target's number from one server while the claim wrote to another. The answer to that is to
qualify the preflight, the reads, the lookup, the release and its verification as well, which is five more places
to get right and a corpus that can no longer pin what the tool asks, because a stored recording has its hosts
replaced by a placeholder (ADR-0024).

Refusing costs one check at the seam every command already passes through, and it needs no host in any argument.
It also covers the read, which qualification would have had to reach separately.

It is refused whatever it names, GitHub's own host included. That is not laziness about the comparison: the
comparison needs `isGitHubHost`, which lives with the reference types that import the runner, so making the check
smarter would move it off the seam it protects. Nothing this tool does needs the variable, so refusing all of it is
the honest rule.

This is the same shape as ADR-0026 for git, and the scope boundary is deliberate: GitHub Enterprise is not
supported, so an environment configured for it is turned away rather than half-accommodated.

## A key that does not name the issue the reference does

Two spellings do this, and they need different answers: one the CLI reads as a flag, one it silently renumbers.

### Read as a flag

The issue is a positional word and `gh` takes flags in any position, so a key spelled like a flag is read as
one. Measured on gh 2.100.0 against a real repository, with `--repo` and `--add-assignee` present:

| key in the positional slot | without `--` | after `--` |
| --- | --- | --- |
| `--help`, `-h` | exit 0, prints help, claims nothing | exit 1, `invalid issue format` |
| `--nope`, `--add-label`, `--repo` | exit 1 | exit 1 |

The help flags are the whole hazard: they report success through the one channel this design trusts. The others
already fail loudly and never needed a guard.

The key therefore goes last, after `--`. That is a structural end to the question rather than a list of
spellings to keep refusing — the same move ADR-0025 records for a worktree's identity, where refusing each
newly-demonstrated bad `.git` file gave way to one positive assertion of what the directory is. A separator
cannot fall behind a CLI that adds a flag, and it costs nothing.

### Silently renumbered

The separator does nothing about this one, and the regex beside it is not decoration. Measured:

| step | result |
| --- | --- |
| `resolveTicketRef` on a short form whose number is written `037` | accepted, `key: "037"` |
| `gh issue view --repo <repo> -- 022` | issue **22** — normalized, separator or not |
| `compareTicketRefs("037", "37")` | `-1`, so the ladder calls them different tickets |

`compareKeys`' own docstring already states the rule: "`07` and `7` are numerically equal and are different
tickets." So a padded reference builds its worktree, branch and session prompt for `#037` while the claim lands
on `#37` and reports success.

`githubClaimCommand` therefore requires a *canonical* number — `/^[1-9][0-9]*$/`, refusing leading zeros and a
bare `0` — and for this hazard that check is the entire safety, not an assertion beside `--`. Calling it an
assertion would invite loosening it, which is what opens the hole.

`claimGitHubTicket` deliberately does not restate the check, so the error keeps its own type and stack rather
than being relabelled a claim failure. Nothing calls the claim yet, so that is a requirement on the launcher
when it lands rather than behaviour already in place: it must let a `CommandBuilderError` through as the broken
invariant it is.

The leak upstream is left open on purpose here: `resolveTicketRef` still *accepts* `#037`, so a padded reference
can exist and only stops at the claim. That is a refusal rather than a wrong write, which is the safety-critical
half; canonicalizing the reference itself belongs to whoever owns reference parsing, because it also decides
worktree names and ladder identity.

### Why the repository path is not checked here too

`claimGitHubTicket` requires `owner/repo` to be exactly two segments; `githubClaimCommand` does not. That looks
like the placement argument above applied inconsistently, and the reason is concrete: `gh` honours a
`[HOST/]OWNER/REPO` value in `--repo`, and the capture script depends on it — `claim-outage` is captured by
handing the builder a three-segment value naming a host that cannot resolve. A builder that refused it could not
produce that recording. So the host rule lives with the caller that has a reference to judge, and the builder
stays able to spell a deliberately bad repository.

## Consequences

A GitHub Enterprise ticket cannot be claimed. That closes no path that worked: the read adapter already
refuses an origin remote on any other host. Supporting it means carrying the host into the argv, not relaxing
this guard.

Neither refusal makes the claim safe against a concurrent one, and neither is a step toward it. ADR-0018 is
still the boundary, and the reason there is no read-back is unchanged.

A claim that fails still aborts loudly with no rollback, per
[0016](./0016-the-worktree-is-created-before-the-claim.md). These two are refusals *before* the write, so they
leave the tracker untouched — the worktree from the step before is the only leftover, as that ADR intends.
