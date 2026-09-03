# nextup — universal next-ticket selector and launcher

Labels: `wayfinder:map`

## Destination

One tool that reads a ticket set from GitHub, GitLab, Jira, or local markdown; filters to open,
unclaimed, and unblocked; ranks the survivors deterministically; and launches a session on the winner
in its own git worktree. Replaces three incompatible existing selectors.

Spec: nichenke/ai-configs#55

## Notes

Design settled by grilling session, 2026-09-03. Four ADRs in `docs/adr/`. These tickets and the ADRs
both move into the `nextup` repo in ticket 02.

## Decisions so far

- [Scope binding lives in user-level config, keyed on the git remote](../../docs/adr/0001-scope-binding-in-user-config.md)
- [The selector is pure and separate from the launcher](../../docs/adr/0002-pure-selector-separate-launcher.md)
- [The ranking ladder is fixed in code, not configurable](../../docs/adr/0003-ranking-ladder-fixed-in-code.md)
- [Bun and TypeScript, not bash or Python](../../docs/adr/0004-bun-typescript-substrate.md)

## Not yet specified

- Whether the harness's native worktree cleanup keys on the worktree path (ticket 03 answers this;
  ADR 0002's cleanup story assumes it does).
- Whether the markdown adapter must tolerate both the plain-field ticket format observed in real
  ticket sets and the bold-field format the `to-tickets` skill emits, or whether one is normalised.

## Out of scope

Retiring ai-bob-brain; stale-claim detection; map parsing of any kind; worktree removal; enforcing the
claim; a general record-and-replay harness; sandboxing the launcher; org-scale configuration and auth.
