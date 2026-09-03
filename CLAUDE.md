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
to write by accident in documentation:

- **Anything matching the tracker-key form** — two to ten uppercase letters, a hyphen, then digits.
  This catches an internal project key, which is the point, but it also catches every standards
  identifier written that way: character encodings, the date-format standard, hash and cipher names,
  RFC and CVE numbers, and this repo's own ADR citations. Cite an ADR by number without the hyphen
  (`ADR 0003`) or by filename, and spell a standards name out in prose rather than as its
  abbreviation-hyphen-number form.
- **A URL to a specific issue or pull request in this repo** — the allowlist holds whole URLs
  including the number, so each new reference needs its own entry. Prefer a bare `nichenke/nextup`
  and the issue number in prose.

Both workarounds are temporary and tracked as items 3 and 5 of issue 19; remove this section's
advice when they land rather than leaving it to rot. The reason to care about either: a guard that
fires on benign changes gets rubber-stamped, and a rubber-stamped allowlist is how a real internal
hostname gets added by reflex.

Run it with `bun run check:identifiers` before pushing.
