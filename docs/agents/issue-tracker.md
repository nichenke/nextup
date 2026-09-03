# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `nichenke/nextup`. Use the `gh` CLI for all
operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json title,body,labels,comments --jq '{title, body, labels: [.labels[].name], comments: [.comments[].body]}'`. `--jq` requires `--json`: `gh issue view <number> --comments --jq ...` exits with ``cannot use `--jq` without specifying `--json` `` and returns no data. Reserve `--comments` for human-readable output, with no `--jq`.
- **List issues**: `gh issue list --state open --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters. `--limit` defaults to 30 (gh 2.98.0), so a backlog past that truncates silently rather than erroring.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

Prefer `--body-file` with a heredoc over an inline `--body` for anything longer than a sentence.
Issue and comment bodies here run long, and shell quoting mangles backticks and `$` in a body passed
inline.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api repos/<owner>/<repo>/pulls --paginate --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not)'`. `gh pr list --json` has no `authorAssociation` field on gh 2.98.0 and fails with `Unknown JSON field`, so the association has to come from the REST endpoint, where it is spelled `author_association`.

  Exclude the three internal associations rather than listing the external ones. The enum has eight members — `gh api graphql -f query='{ __type(name: "CommentAuthorAssociation") { enumValues { name } } }'` — and an earlier version of this line named three of the five external ones, silently dropping a `FIRST_TIMER` (first contribution anywhere on GitHub, distinct from `FIRST_TIME_CONTRIBUTOR`) and a `MANNEQUIN` from the triage queue. The internal set is closed and stable; the external set is the one GitHub extends. Excluding the internal three also fails in the safe direction, since an association nobody anticipated shows up for triage instead of vanishing from it.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: read the map's children in map order with `gh api repos/<owner>/<repo>/issues/<map>/sub_issues --paginate`, or from the map body's task list where sub-issues aren't enabled. `gh issue list` cannot do this job — it orders globally rather than by map position, so "first in map order wins" is unimplementable through it, and its `--limit` default of 30 starts dropping children once the repo's open issues pass that. Drop any child that is closed, assigned, or reports `issue_dependencies_summary.blocked_by > 0` (or lists an open issue in its `Blocked by` line); the first survivor wins.
- **Confirm the survivor before claiming it**: `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by`. The summary field the frontier query reads lags a freshly written edge and can report `0` for a ticket that is already blocked, and a session reading the frontier cannot tell that an edge was just written. Where native dependencies aren't available, re-read the child's `Blocked by:` line instead — that endpoint reports only native edges, so in fallback mode it answers "not blocked" for every ticket and would confirm a blocked one as claimable.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write. That assignee *is* the claim: an open, unassigned ticket is unclaimed, and `--remove-assignee` releases it.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

Note that this repo's own domain vocabulary in `CONTEXT.md` defines **Ticket**, **Blocker**, and
**Frontier** as the terms `nextup` itself implements. The wayfinding operations above are how those
concepts are represented in the tracker; the glossary is what they mean in the code. Keep the two
readings distinct when writing about either.

## Labels

`gh issue edit --add-label` fails on an unknown label rather than creating it, so a skill reaching for
a label the tracker lacks stops mid-triage with the state half applied. Check against the tracker
rather than against a list written here:

```sh
gh label list --json name --jq '[.[].name] | sort'
```

An enumeration in this file goes stale the moment a label is added, which is what happened to the
first version of this section — it named five labels, and three more were created minutes later.
`triage-labels.md` is the contract for which names the skills use; this command is how you confirm
they exist.
