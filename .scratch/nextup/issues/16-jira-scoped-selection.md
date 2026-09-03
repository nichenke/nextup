# 16 — Jira scoped set selection and the config binding

**What to build:** Jira participates in set selection, scoped explicitly so the tool can never recommend
another team's work — and the scope is remembered so it need only be answered once.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] An explicit project or query scope is accepted on the command line
- [ ] A user-level config file outside every repository stores the binding, keyed on the normalized git remote slug rather than the filesystem path, because a worktree has a different path and the same remote
- [ ] The config may hold only scope binding — which tracker, which project, which host — and never ticket state, ranking configuration, or label policy
- [ ] Precedence is explicit flag, then config, then refusal
- [ ] The first unscoped invocation lists accessible projects, asks which one binds to this repository, and writes the entry
- [ ] In a non-interactive context it does not prompt — it refuses and prints the exact line to add
- [ ] An unscoped Jira invocation never guesses a project
- [ ] Repositories with no Jira relationship still need no config at all
