# nextup

## Agent skills

### Issue tracker

Issues live as GitHub issues in `nichenke/nextup`, driven through the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map one-to-one onto identically named labels. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Required reviews

Run both before opening a pull request, and treat what they return as claims to check rather than
findings to apply:

- **`pr-review-toolkit:type-design-analyzer`**, on any diff that adds or changes a type in the
  normalized ticket surface — `Ticket`, `TicketRef`, blocking state, adapter return shapes. The point
  is that `Unknown` stays unrepresentable as blocked-or-unblocked: `CONTEXT.md` names that collapse
  as the thing never to allow, and a type permitting it fails no test.
- **`/nichenke:comment-review`**, on any diff that adds or changes a comment. The guard's reasoning
  already appears in three places — this file, `README.md`, and `scripts/check-identifiers.sh` — so
  the risk here is a fourth copy rather than a missing explanation, and the auditor reads the whole
  diff, which is what catches one fact written into several files.

Both ship as Claude Code plugins from outside this repo. If either is unavailable, say so in the pull
request instead of passing over it — a review that never ran, reported as clean, costs more than one
that is openly missing.

## Markdown shapes

Only create and test markdown shapes that another tracker could produce. Markdown is the fixture
substrate for the contract, not a format to reverse-engineer: a shape earns its place by standing in for
something GitHub, GitLab or Jira can hand back, and the question to ask of a proposed case is which
tracker behaviour it stands in for. ADR-0010 has the mapping and the reasoning, including why the answer
"markdown permits it" is the one that produced seven rounds of review churn.

## Identifier guard

`scripts/check-identifiers.sh` fails on any identifier-shaped token in a tracked file that is not
allowlisted, and CI runs it first, before any dependency install. Run it with
`bun run check:identifiers`.

Standards identifiers pass without an allowlist entry, so ordinary prose needs no workaround. Two
things do:

- **A URL to a specific issue or pull request** costs one `ALLOWED` line, added deliberately as its
  own reviewable change. Prefer a bare `nichenke/nextup` and the number in prose. Accepting anything
  under a prefix instead was tried and reverted — it accepted a private host smuggled into a query
  string. ADR-0006 has the reasoning and the narrow fix to reach for if this friction bites.
- **A comment or fixture cannot spell out a dotted host followed by `/` or `:`**, even to explain the
  guard, because the guard reads its own source. Split it across string concatenation the way the
  test fixtures do.

Run it with `bun run check:identifiers` before pushing.
