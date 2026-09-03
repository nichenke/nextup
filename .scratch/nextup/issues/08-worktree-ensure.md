# 08 — Worktree ensure and branch naming

**What to build:** After claiming, the command creates the ticket's worktree — or attaches to it if it
already exists, so that re-running after a partial failure heals instead of erroring. Still prints
rather than launches.

**Blocked by:** 07, 03

**Status:** ready-for-agent

- [ ] Attaches to an existing worktree for the branch at the expected path rather than failing
- [ ] Typed refusals for a stale directory and for a branch already attached elsewhere
- [ ] Distinguishes creating a new branch from attaching an existing one
- [ ] Worktree root is parametric, so a future Codex launcher can use a different location without forking the tool
- [ ] Default root follows whatever ticket 03 established about native cleanup
- [ ] Branch names follow the existing convention: feature or fix prefix determined by a bug label, then slug, then ticket number — number last so tab-completion works on the slug
- [ ] Markdown tickets, which carry a number in the filename, follow the same branch shape
- [ ] Warns when the primary checkout is not on the default branch, without refusing
- [ ] Failures at or after this step keep the claim, so a ticket with a half-finished branch is never advertised as available
- [ ] Tested both by asserting issued argv and by a real-git block in a temporary repository, because the failure modes this step exists to handle are real porcelain behaviours
- [ ] Worktree removal is deliberately not implemented
