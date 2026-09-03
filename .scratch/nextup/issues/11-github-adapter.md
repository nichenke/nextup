# 11 — GitHub adapter

**What to build:** The tool works on GitHub repositories, which is where the implementations it replaces
operate. This is v2.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] Reads blocking edges from the native dependencies API
- [ ] Falls back to parsing a `Blocked by:` line from the issue body when that endpoint is unavailable, resolving references as either issues or pull requests
- [ ] Falls back to unknown only after both, so unknown means a narrow comprehensible case rather than a common one
- [ ] An unavailable endpoint is treated as an outage — flagged and continued past; a 4xx is treated as a defect and fails loud
- [ ] Claim is the assignee
- [ ] Priority is derived from labels
- [ ] Pagination is safe: a truncated fetch reports itself truncated
- [ ] Repository is resolved from the working directory's git remote, with no hardcoded repository name
- [ ] Driven entirely by stub fixtures in CI, with no credentials
