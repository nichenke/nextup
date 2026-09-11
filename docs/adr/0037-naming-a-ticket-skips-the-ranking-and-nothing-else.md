# Naming a ticket skips the ranking and nothing else

A reference on the command line — `nextup gh:12`, or a pasted issue URL — starts work on that ticket
instead of the one the ladder would have chosen. This is what that override does and does not skip,
and what `--force` is for.

## The ranking and the candidate filter go; the two checks stay

Both the ladder and the label filter decide what may be **recommended**, and an override recommends
nothing — the operator has already chosen. So neither is consulted: a named ticket carrying `spec`,
`needs-triage` or `wayfinder:*` starts, and `--include`/`--exclude`/`--limit` beside a reference are
refused as a bad invocation rather than quietly ignored, because each describes a read that will not
happen.

What stays is every check about whether the work can be started at all:

- **Closed.** There is no work to start.
- **Claimed.** Somebody is already on it.
- **Blocked.** A blocker is confirmed open.

Naming a ticket by hand is exactly the path where the frontier query is bypassed, so these are the
checks that matter most here rather than least. `CONTEXT.md`'s **Unknown** is not among them: a ticket
whose blocking state the tracker could not report is not blocked, and the ranking path recommends such
a ticket when nothing confirmed is left. The override reports the state on the gate's own line —
`blockingPhrase` is shared with the ranking path so the two cannot word one ticket differently — and
lets the operator decide.

## `--force` clears the blocked and the claimed check, and never the closed one

The first two are judgments about state somebody else wrote, and both are ones an operator can be
right to overrule: a blocker that is open but irrelevant to the slice in front of them, a claim left
on a ticket nobody is working. Starting anyway is a decision, so the flag exists, the gate still asks,
and every check it cleared is named on a `forced: ` line — greppable like `degraded: ` and
`deadlock: `, and carried into the question so it is read before the claim rather than after.

A closed ticket is different in kind. It is the tracker's own canonical state saying the work is
finished, not an inference from somebody else's judgment, and the repair is to reopen it. Forcing past
it would start a session on work that is done and claim it besides, so `--force` does not reach it and
the refusal says to reopen instead. [ADR-0021](./0021-a-closed-ticket-is-closed.md) is the same rule
read from the blocker side: a closed ticket is closed, whatever closed it.

## A forced start still claims

Skipping the blocked check is a judgment a person is entitled to make; skipping the claim only makes
the work invisible to the next session, which is the one thing the claim exists to prevent. So the
write order is unchanged — worktree, claim, session — and `--force` changes nothing about it.

The claim is additive on every tracker here: `--add-assignee` adds rather than replaces. Forcing past
an existing claim therefore leaves both names on the ticket, which is the honest record of what
happened and is visible to whoever held it first.
[ADR-0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md) still applies — nothing arbitrates,
and a second name is a report rather than a resolution.

## The named ticket is read by its own call, not found inside the set read

The set read asks for open tickets only, bounded by `--limit`, in the repository the origin resolves
to. Looking a named ticket up inside that answer would report "not found" for a ticket that exists and
is simply closed, outside the window, or in another repository — the three cases the override is most
often reached for. Worse, the closed one would read as absent rather than as closed, which is the
refusal an operator most needs worded correctly.

So `readGitHubTicket` is a single-issue read of the same projection
(`GITHUB_TICKET_FIELDS`), parsed by the same row reader. `gh issue view` carries no state filter, so
a closed ticket comes back as a closed ticket and the refusal can say so. The key is guarded the way
[ADR-0032](./0032-the-claim-refuses-two-shapes-a-zero-exit-would-not-warn-about.md) guards the
claim's: `gh` normalizes `037` to issue 37 while `compareTicketRefs` treats the two as different
tickets, so a padded key would read one issue under a reference naming another.

A reference naming a tracker this has no adapter for — `glab:`, `jira:` — is refused here rather than
read. The spec brings both in later, GitLab first and Jira override-only.

## `--print-command` with a named ticket reads nothing

It starts nothing, creates nothing and claims nothing, and the session command follows from the
reference alone, so there is nothing for a tracker read to contribute. Not reading keeps it the
sandbox-safe path the spec calls it — usable with no credentials and no network — at the cost that it
cannot tell you the ticket is blocked. The checks gate writes, and this writes nothing.

## Consequences

A page of blockers reads as `unknown` here rather than holding the ticket out. `readEdges` returns
`"partial"` without the retained edges, and the set read's answer to that is to drop the ticket from
the answer entirely — which on this path would be a refusal of the one ticket the operator named. So
the graph is seeded `"unknown"`, the state reads unknown, and a `degraded: ` line says only a page
arrived.

The cost is that a retained edge naming a confirmed-open blocker no longer reads as blocked, so such a
ticket starts without `--force` and reports `blockers unknown` while being blocked in fact. Making
that case confirmable means `readEdges` returning the retained edges beside the `"partial"` verdict,
which changes the set read's own partition and is deliberately not done here.

The override has no counts line, no decision line and no `unblocks` count. Nothing ranked, so there is
no runner-up to have beaten and no ticket set to account for; `unblocks` counts dependents within a
set that was never read, and reporting a zero for it would be the collapse
[ADR-0011](./0011-what-each-ranking-rung-reads.md) calls a lower bound at best. The override's target
is therefore its own type rather than a `Candidate`, which also keeps `Candidate.blocked`'s promise
that it is never `"blocked"` — a forced target can be.
