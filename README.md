# nextup

**Unblocked Opportunist** — picks the best unclaimed, unblocked ticket and starts work on it.

`nextup` reads a ticket set from GitHub, GitLab, or Jira; filters to open and unclaimed;
ranks the survivors deterministically; and launches a session on the winner in its own git worktree.

Blocking is tri-state, so "unblocked" is not a simple filter. Tickets whose blockers are *confirmed*
closed are ranked first. Tickets whose blocking state the tracker could not report are ranked by the same
rules but consulted only when nothing confirmed-unblocked is left — surfaced loudly, never silently
treated as unblocked.

## Status

End to end on GitHub. Run it inside a GitHub checkout and it reads the repository the origin remote points
at, ranks the candidates, shows you the pick, and — once you agree — makes the ticket's worktree, claims the
ticket, and starts a session in that worktree.

```sh
bun bin/nextup.ts                       # show the pick, then ask before starting it
bun bin/nextup.ts --limit 50            # consider 50 open tickets rather than the default 199
bun bin/nextup.ts --json                # the selection, and what the run did about it, as JSON
bun bin/nextup.ts --yes                 # start without asking, for an unattended run
bun bin/nextup.ts --slash-command /triage   # start a triage session rather than an implementation
bun bin/nextup.ts --print-command       # print the session command, starting nothing
bun bin/nextup.ts --help                # every flag
```

Starting writes in three places, in this order: the worktree, then the claim, then the session. Nothing
unwinds, so a step that fails leaves what the steps before it did and running the command again continues
from there.
[ADR-0016](./docs/adr/0016-the-worktree-is-created-before-the-claim.md) has why that order needs no
recovery code, and why the leftover of a failure should be a directory rather than your name on work
nobody is doing.

The session runs in a cmux workspace, and there is no fallback: a workspace host that is not running is
refused *before* the worktree and the claim, so a run that could never have started a session writes
nothing at all.
[ADR-0035](./docs/adr/0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md)
has why the two available fallbacks were both worse than the refusal, and why the check cannot close the
window it narrows.

Only open tickets are read, and the counts line says `closed not asked` rather than reporting a zero as a
count. The window is the most recently created open tickets, so a backlog larger than `--limit` never
considers its oldest — the truncation sentinel is what says so.
[ADR-0028](./docs/adr/0028-the-read-asks-for-open-tickets-and-the-closed-count-says-so.md) has the
measurement that makes that safe for blocking, and what the default limit claims.

A **deadlock** — `CONTEXT.md` has the term — is named on a `deadlock: ` line, each ticket followed by the one
blocking it and closing on the ticket it started from, so every edge can be followed in the tracker. Not one
line per loop: where loops interlock, some are named and the rest are the same tickets over again, so an
absent line is not the absence of a cycle. It is reported beside the answer rather than instead of it, since a
cycle in one corner of a repository does not stop a pick from another, and under `--json` it is
`selection.deadlocks` — neither of the two degrade lists below.
[ADR-0030](./docs/adr/0030-a-deadlock-is-named-beside-the-answer.md) has what gets named, why the selector
detects it, and why no adapter refuses it.

`--help` has the label-filter semantics and the exit codes. A degraded answer carries one `degraded: ` line
per reason, which is the sentinel to grep for — a truncated read, a pick whose blockers nothing could
confirm, a tracker that could not be reached, rows that did not report their blockers, tickets held back
because only part of their blockers arrived, and blockers two edges disagreed about. Each is one line
whatever the tracker's own message did, so the prefix is a reliable filter.

A tracker that could not be reached is a degraded answer with nothing to recommend rather than a failure:
the request was fine, so a retry is the response. Exit 2 is for what needs a person — a bad invocation, an
origin that is not GitHub, a request the tracker rejects, a response that cannot be read, no way to confirm
and no `--yes`, a workspace host that is not running, a worktree that cannot be made, a claim that will not
land, and any failure nothing classified.

`--json` carries the reasons as two lists, and a consumer has to read both: `selection.degraded` is what the
selector concluded about the ticket set, and `readDegraded` is what the read itself could not do. An outage
appears in the second while also setting the first to `truncated`, since nothing was read — so a wrapper
keyed only on `truncated` would answer a network outage by widening a window that was never opened.

Nothing is started without an answer. The gate asks on the controlling terminal rather than through stdin and
stdout, so it still works when either is redirected, and the question names the pick because the rendering it
is about has not been printed yet. `--yes` answers in advance; with neither a terminal nor `--yes` the run is
refused rather than answered on your behalf. Declining exits 0 — the gate did its job — so a script that
needs to know whether a session started passes `--yes` and reads the `start` object under `--json`.

`--print-command` starts nothing, creates nothing, claims nothing, and never asks. It prints the session
command after the answer, and `--json --print-command` carries it as `start.command`. It is both the
sandbox-safe bridge
([ADR-0002](./docs/adr/0002-pure-selector-separate-launcher.md)) and what to reach for when the workspace
host is down.

- [The spec](https://github.com/nichenke/nextup/issues/2) — problem, solution, user stories, and the
  phased delivery
- [The ticket set](https://github.com/nichenke/nextup/issues?q=is%3Aissue+label%3Aready-for-agent) —
  children of the spec, wired with native blocking edges rather than an order written into their titles
- [`docs/adr/`](./docs/adr/) — the architecture decisions, each one a thing a reader would otherwise try
  to "fix"
- [`CONTEXT.md`](./CONTEXT.md) — the glossary, and the reason it exists: the concepts here already carry
  three different names across the implementations this replaces

## Design in one screen

Two layers, deliberately separate:

- **The selector is a pure function.** Ticket set, claim state, and blocking graph in; ranked candidates
  with reasons out, as JSON. No side effects and no model in the decision path, so its output can be
  asserted exactly against a fixture.
- **The launcher is a thin shell over it.** It ensures a worktree, claims the ticket, and starts a
  session. It is the only part that writes anything, and the only part that cannot be sandboxed.

The worktree comes first, the claim second, and the session third, so that no failure needs undoing — see
[ADR-0016](./docs/adr/0016-the-worktree-is-created-before-the-claim.md). A failed claim aborts loudly
and leaves the worktree in place; re-running attaches to it and retries, because `ensure()` is
idempotent. There is no release path and no rollback. The leftover on failure is a worktree, which
`git worktree list` reports and the next attempt reuses, rather than a claim advertising work nobody is
doing.

The one failure that ordering cannot help is a workspace host that is not running, which would strand both
a worktree and a claim behind a session that never started. So the host is asked before either, and a host
that does not answer is refused rather than fallen back from —
[ADR-0035](./docs/adr/0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md)
has why, and why that check narrows the window rather than closing it.

Ensuring the worktree is one of three things, and the outcome says which: the branch and the worktree
both created, a worktree made for a branch that already existed, or an attach to the worktree already
at the expected path. Anything else is refused by kind rather than left to `git worktree add`'s own
fatal — something other than the wanted worktree at that path, or the ticket's branch already checked
out at a different one. The branch is `feature/` or `fix/` by whether the ticket is labelled a bug,
then the title as a slug, then the ticket's key last. It goes under
`.worktrees/` in the primary checkout unless a caller names another root, and never gets removed —
[ADR-0013](./docs/adr/0013-worktrees-go-under-the-primary-checkout.md) has why there and
[ADR-0005](./docs/adr/0005-worktree-removal-stays-unimplemented.md) why nothing cleans up. A primary
checkout that has drifted off the default branch is warned about rather than refused; `driftWarnings`
has why that is worth saying.

Everything before the claim — the ranking, the plan, the gate — writes nothing to the tracker, so a
declined pick and a wrong input both cost no tracker write to find out.

The claim is one write and its exit status is the whole verdict. Nothing is read back, and two starts of
the same ticket are not arbitrated: every agent here authenticates as one identity and assignees carry no
atomic test-and-set, so no tracker call can tell this session's write from a sibling's. That is a scope
boundary rather than an unfinished edge —
[ADR-0018](./docs/adr/0018-concurrent-claim-arbitration-is-out-of-scope.md). A claim is advisory;
`CONTEXT.md` says what that means.

Ranking is a fixed ladder, each rung skipped when its signal is absent, with the last rung guaranteeing
a total order:

1. Priority signal
2. How many other tickets this one unblocks
3. Ascending reference — unique by construction, so the order is total however many projects a query
   spans

ADR-0003 fixes that order and the reference rung; ADR-0011 says what the other two read, including why
`priority:high` is reported rather than ranked.

## Fixing a bad pick

The ladder is fixed in code and has no knobs, so the way to change an answer is to record the answer you
wanted and change the rule. Scenarios live in `fixtures/scenarios/` as paired files: `<name>.input.json`
is a ticket set and the filter applied to it, and `<name>.expected.json` is the selection the code
currently produces.

1. Add a `<name>.input.json` holding the smallest ticket set that produces the bad pick. Its
   `description` says what ranking behaviour the set pins. A scenario input is authored rather than
   captured, and ADR-0019 says why that is legitimate here and not for a recording.
2. Write `<name>.expected.json` by hand, or run `UPDATE_SCENARIOS=1 bun test src/scenario.test.ts` and
   read the diff. Regenerating without reading is how a bad pick becomes the recorded expectation.
3. Watch it fail, then change the ladder until it passes.

Every key is validated and an unrecognised one is refused: a misspelled key in a fixture reads as a
scenario that passes while asserting nothing, which looks like coverage rather than a gap.

A scenario may also carry a `<name>.expected.txt`, holding the human rendering rather than the JSON.
Only a couple do: the JSON pins which ticket wins, and these pin the shape of what a person reads —
line order, the blank line, the sentinel last — so a wording change arrives as a diff to approve
instead of passing unnoticed. Add one by creating the file empty and regenerating.

## The command contract

Every external command is built by a typed builder in `src/command-builders.ts`, and each builder's
output is captured under `fixtures/commands/` alongside the input that produced it. A change to what
this tool invokes therefore arrives as a diff to read rather than as a behaviour to discover.

Add a case by declaring it in `src/command-builders.test.ts` and running
`UPDATE_COMMANDS=1 bun test src/command-builders.test.ts`, which writes the golden and, like the
scenario suite, refuses to regenerate under `CI`. Cases are declared rather than discovered, so a
deleted golden fails instead of quietly dropping its assertion.

## Development

```sh
bash scripts/check-identifiers.sh
bun install
bun test
bunx tsc --noEmit
```

`bun test` is transpile-only, so the typecheck is a separate gate rather than something the test run
covers. All of these run in CI, and CI needs no credentials — the whole tool is driven through one
injected process runner, so tests never touch a network or an external binary.

What a tracker read is asserted against comes from `fixtures/recordings/`, captured by a credentialed
local run that is never part of the above: `docs/agents/test-tree.md` has the command and the rules.

A fixture only ever puts a shape where its author expected one, so `bun run check:live` performs
`CONTEXT.md`'s **reconstruction**: it reads a real repository through the adapter and checks the answer
against the tracker's own account of the same tickets. Credentialed, local, and never CI, for the same
reason the capture is:
`docs/agents/reconstruction.md` has how to run it and what each verdict means.

The guard runs first, before any install, and CI keeps that order. It needs no dependencies, and
ordering it after `bun install` once meant a failing install stopped it from running at all — on a
commit whose lockfile held a private registry host.

`scripts/check-identifiers.sh` is an allowlist, not a denylist: a denylist of real hostnames would
itself be the content it guards. It exists for one job — catching a canonical identifier someone pasted
into a tracked file — and recognises a scheme URL, an email or scp-form remote, a *dotted* schemeless
host followed by a separator, and a cross-repo issue reference. That list is frozen.

The dotted requirement is load-bearing: a single-label host or an IP address in an otherwise canonical
reference — `registry:5000/team/app`, `10.0.0.1:5000/team/app` — matches nothing, because the final
label must be letters. That is the same accepted cost as the bare-host gap: relaxing it to catch
`name:port/path` would flag ordinary code and config.

It does **not** detect tracker keys, obfuscated encodings, or a bare hostname with nothing after it, so
`check-identifiers: ok` means one narrow class was absent when it ran, not that the diff is clean. It
printed `ok` on the day of the original leak, before `bun.lock` was regenerated. Prevention lives in
`bunfig.toml` pinning the public registry, which CI asserts by exact comparison before any install.
ADR-0006 records the scope, the accepted residual risks, and what was rejected.
