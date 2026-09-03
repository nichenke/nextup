# 15 — Jira, override-only

**What to build:** A Jira ticket can be named directly and worked on, without Jira participating in set
selection. This is the useful increment that costs almost nothing once reference parsing handles Jira
keys, and it deliberately avoids the scoping problem.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] A Jira reference or a pasted browse URL resolves and can be targeted directly
- [ ] Blocking edges are read from native issue links
- [ ] Claim is the assignee
- [ ] Priority is read from the first-class priority field where ranking applies
- [ ] Jira never contributes candidates to set selection at this stage, and says so plainly if asked to
- [ ] Fixtures use only synthetic project keys from the allowlist — no real project key is committed
