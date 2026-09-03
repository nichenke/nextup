# 03 — Verify what the harness's native worktree cleanup keys on

Type: research

**What to build:** A documented, evidenced answer to a single question: when a session exits, does the
harness's native "keep or remove this worktree?" prompt trigger based on the worktree's *path*, and if
so which path? ADR 0002's cleanup story assumes it does, and neither the bash nor the TypeScript prior
art implements `git worktree remove` — so if the assumption is wrong, removal is an unclosed gap and the
default worktree root changes.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The answer is reproduced, not inferred — a real session in a real worktree, observed
- [ ] If it is path-keyed, the exact path convention that triggers it is recorded
- [ ] If it is not path-keyed, the actual trigger is recorded, and the consequence for the default worktree root is stated
- [ ] Findings are written into the repo where ticket 08 will read them, and ADR 0002 is amended or confirmed
