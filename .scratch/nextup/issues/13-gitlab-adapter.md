# 13 — GitLab adapter

**What to build:** The tool works on GitLab. This one fills a gap rather than replacing a duplicate —
the GitLab-hosted ticket map has no selector or launcher at all today.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] Reads blocking edges from native issue links
- [ ] Falls back to prose parsing, then to unknown, on the same ladder as GitHub
- [ ] Claim is the assignee
- [ ] Host is discovered from the installed CLI's own configuration, never hardcoded
- [ ] Pagination is safe and truncation self-reports
- [ ] Driven entirely by stub fixtures in CI, with no credentials
