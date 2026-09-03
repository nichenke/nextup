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
allowlisted verbatim, and CI runs it before any dependency install. Two shapes it rejects are easy
to write by accident in documentation: a project-key form such as `ADR` followed by a hyphen and
digits, and a URL to a specific issue or pull request in this repo. Reference an ADR by number
without the hyphen, and prefer a bare `nichenke/nextup` over a full URL, so routine docs do not
require an allowlist edit. The reason to care is in issue 19: a guard that fires on benign changes
gets rubber-stamped, and a rubber-stamped allowlist is how a real internal hostname gets added by
reflex.

Run it with `bun run check:identifiers` before pushing.
