# nextup

**Unblocked Opportunist** — picks the best unclaimed, unblocked ticket and starts work on it.

`nextup` reads a ticket set from GitHub, GitLab, Jira, or local markdown; filters to open and unclaimed;
ranks the survivors deterministically; and launches a session on the winner in its own git worktree.

Blocking is tri-state, so "unblocked" is not a simple filter. Tickets whose blockers are *confirmed*
closed are ranked first. Tickets whose blocking state the tracker could not report are ranked by the same
rules but consulted only when nothing confirmed-unblocked is left — surfaced loudly, never silently
treated as unblocked.

## Status

The selector works on local markdown ticket sets, and the launcher claims. A run reads an effort, ranks
what is startable, shows the pick and what starting it would run, and claims the winner once you say so.
Nothing local is created yet — no worktree and no session — and the GitHub, GitLab and Jira adapters are
not built.

```sh
bun bin/nextup.ts                   # show the pick, ask, and claim it if you agree
bun bin/nextup.ts --yes             # claim without asking, for an unattended run
bun bin/nextup.ts --print-command   # the same answer, claiming nothing and asking nothing
bun bin/nextup.ts --json            # the selection, the claim, and the command, as JSON
bun bin/nextup.ts --help            # every flag
```

It reads the single effort under `<cwd>/.scratch`, or the one `--effort <path>` names. `--help` has the
label-filter semantics and the exit codes. A degraded answer — a truncated fetch, or a pick whose
blockers nothing could confirm — carries one `degraded: ` line per reason, which is the sentinel to
grep for.

Nothing is claimed without an answer. The gate asks on the controlling terminal rather than through
stdin and stdout, so it still works when either is redirected, and a run with no terminal and no `--yes`
is refused rather than answered on your behalf. `--print-command` neither claims nor asks: it prints the
command on stdout and the reasoning on stderr, and `--json --print-command` is the whole answer with
nothing claimed.

- [The spec](https://github.com/nichenke/nextup/issues/2) — problem, solution, user stories, and the
  phased delivery
- [The ticket set](https://github.com/nichenke/nextup/issues?q=is%3Aissue+label%3Aready-for-agent) — 16
  tickets, children of the spec, wired with native blocking edges
- [`docs/adr/`](./docs/adr/) — the architecture decisions, each one a thing a reader would otherwise try
  to "fix"
- [`CONTEXT.md`](./CONTEXT.md) — the glossary, and the reason it exists: the concepts here already carry
  three different names across the implementations this replaces

## Design in one screen

Two layers, deliberately separate:

- **The selector is a pure function.** Ticket set, claim state, and blocking graph in; ranked candidates
  with reasons out, as JSON. No side effects and no model in the decision path, so its output can be
  asserted exactly against a fixture.
- **The launcher is a thin shell over it.** It claims the ticket, ensures a worktree, and starts a
  session. It is the only part that writes anything, and the only part that cannot be sandboxed.

The claim comes first, before anything exists locally, so a failure leaves a visible wrong state in the
tracker rather than an orphan on a disk nobody is looking at. Everything before it — the ranking, the
plan, the gate — is pure, so a declined pick and a wrong input both cost no tracker write to find out.
A claim that cannot land aborts having changed nothing, and one that lands but cannot be verified is
rolled back — or says plainly that it could not be, because a claim left on a ticket nobody is working
is the failure the whole step exists to avoid. The boundary past which a claim is kept rather than
given back is where a worktree starts existing; the launcher does not create one yet, so nothing
crosses it today. A claim is advisory — `CONTEXT.md` says what that means — and for markdown it overwrites the
`Status:` line, which ADR-0012 explains.

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
   `description` says which tracker behaviour the shape stands in for — the same standard `CLAUDE.md`
   sets for markdown fixtures.
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
