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

Standards identifiers and this repo's own issue URLs pass without an allowlist entry, so ordinary
documentation needs no workaround. One constraint does apply when editing tracked files: the guard
reads its own source, so a comment or test fixture cannot spell out a dotted host followed by `/`
or `:`, even to explain the guard. Split it across string concatenation the way the test fixtures
do.

Run it with `bun run check:identifiers` before pushing.
