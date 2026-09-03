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

Ranking is a fixed ladder, each rung skipped when its signal is absent, with the last rung guaranteeing
a total order:

1. Priority signal
2. How many other tickets this one unblocks
3. Ascending reference — unique by construction, so the order is total however many projects a query
   spans

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
