# Scope binding lives in user-level config, keyed on the git remote

`nextup` infers everything it can from the working directory — the repository from the git remote, the
markdown ticket directory from the tree — but a Jira project key cannot be inferred from a git remote,
so that one binding has to be recorded somewhere. We record it in a single user-level config file
outside every repository, keyed on the normalized git remote slug, holding only scope binding: which
tracker, which project, which host.

## Considered Options

A per-repo config file, and a central project registry.

Per-repo config is what makes the most rigorous existing implementation non-portable: `brain next`
requires a `PROJECT.md` scaffold to exist before it works at all, so every new repository needs setup
before the tool is useful. A central registry introduces a second source of truth about which projects
exist, which drifts from what is actually on disk.

Keyed on the remote rather than the filesystem path because a git worktree has a different path and the
same remote — and this tool does its work inside worktrees, so keying on path would silently miss.

## Consequences

The config may never hold ticket state, ranking configuration, or label policy. The moment it does, it
is a second tracker and a ranking that cannot be asserted against a fixture.

Repositories with no Jira relationship need no config at all, so GitHub, GitLab, and markdown stay
zero-config.

Because the file lives outside every repository, a work project key cannot reach the public repository
this tool ships from.
