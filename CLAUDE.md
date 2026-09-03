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

## Identifier guard

`scripts/check-identifiers.sh` fails on any identifier-shaped token in a tracked file that is not
allowlisted, and CI runs it first, before any dependency install. Run it with
`bun run check:identifiers`.

Standards identifiers pass without an allowlist entry, so ordinary prose needs no workaround. Two
things do:

- **A URL to a specific issue or pull request** costs one `ALLOWED` line, added deliberately as its
  own reviewable change. Prefer a bare `nichenke/nextup` and the number in prose. Accepting anything
  under a prefix instead was tried and reverted — it accepted a private host smuggled into a query
  string. ADR 0005 has the reasoning and the narrow fix to reach for if this friction bites.
- **A comment or fixture cannot spell out a dotted host followed by `/` or `:`**, even to explain the
  guard, because the guard reads its own source. Split it across string concatenation the way the
  test fixtures do.

Run it with `bun run check:identifiers` before pushing.
