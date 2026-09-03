# 04 — `TicketRef` parsing: scheme forms and URL shapes

**What to build:** Any reference a user can reasonably supply resolves to one internal normalized shape,
and anything ambiguous is refused loudly rather than guessed. Short forms for all four trackers, plus a
pasted issue URL — because a URL is what is actually in the clipboard.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Short scheme forms parse for all four trackers, with GitHub and GitLab resolving the repository from the working directory's git remote
- [ ] A pasted issue URL resolves by *shape* first: GitLab paths contain `/-/issues/`, GitHub's contain `/issues/`, Jira's contain `/browse/<KEY>-<n>`
- [ ] Shape resolution contains no hardcoded hostname, so nothing employer-specific is committed
- [ ] Where shape is ambiguous, the installed CLIs' own authenticated-host state disambiguates
- [ ] A URL for a host nothing is authenticated to fails loudly — never guessed. Note the Jira config stores an API-gateway host, not the browse host, so hostname comparison against it does not work
- [ ] Both an absolute form (repository-qualified) and a working-directory-relative form are accepted and normalize identically
- [ ] Demoable: a debug subcommand emits the normalized reference as JSON
- [ ] Fixtures use only synthetic identifiers from the allowlist
