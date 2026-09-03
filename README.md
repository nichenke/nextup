# nextup

**Unblocked Opportunist** — picks the best unclaimed, unblocked ticket and starts work on it.

`nextup` reads a ticket set from GitHub, GitLab, Jira, or local markdown; filters to open and unclaimed;
ranks the survivors deterministically; and launches a session on the winner in its own git worktree.

Blocking is tri-state, so "unblocked" is not a simple filter. Tickets whose blockers are *confirmed*
closed are ranked first. Tickets whose blocking state the tracker could not report are ranked by the same
rules but consulted only when nothing confirmed-unblocked is left — surfaced loudly, never silently
treated as unblocked.

## Status

Bootstrapping. Nothing functional yet — the design is settled and written down, but no adapter, selector,
or launcher exists.

- [The spec](https://github.com/nichenke/nextup/issues/2) — problem, solution, user stories, and the
  phased delivery
- [The ticket set](https://github.com/nichenke/nextup/issues?q=is%3Aissue+label%3Aready-for-agent) — 16
  tickets, children of the spec, wired with native blocking edges
- [`docs/adr/`](./docs/adr/) — five architecture decisions, each one a thing a reader would otherwise try
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

Ranking is a fixed ladder, each rung skipped when its signal is absent, with the last rung guaranteeing
a total order:

1. Priority signal
2. How many other tickets this one unblocks
3. Ascending reference — unique by construction, so the order is total however many projects a query
   spans

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bash scripts/check-identifiers.sh
```

`bun test` is transpile-only, so the typecheck is a separate gate rather than something the test run
covers. All three run in CI, and CI needs no credentials — the whole tool is driven through one
injected process runner, so tests never touch a network or an external binary.

`scripts/check-identifiers.sh` is an allowlist, not a denylist. A denylist of real hostnames and project
keys would itself be the content it guards, so publishing the guard would leak what it protects.
