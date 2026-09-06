# A checkout holds one effort, because that is the shape the trackers have

`--effort` says *where* an effort is. It does not say *which* of several to take: a checkout holding
more than one is refused, and the refusal does not offer the flag as the way out.

## Why

An effort is the one thing in this tool with no tracker analogue. `CONTEXT.md` says so in the
glossary — an effort is "the markdown equivalent of a scoped query — it declares its own membership,
which no other tracker's ticket set does." The three trackers still to come scope an invocation from
the checkout's own git remote, or from user-level scope binding for the one case a remote cannot
answer. None of them takes a per-invocation "which set" argument, because none of them has one to
take.

So supporting a choice between efforts is building machinery for markdown alone, which is exactly
what ADR-0010 says to stop doing: effort spent on a risk only markdown has "buys nothing for the
three adapters still to come."

The collision that forced the question is concrete rather than theoretical. Two efforts each number
their tickets from 1, so `md:1` names a ticket in both. `ticket.ts` already records that a markdown
id "is unique only within one effort" and that "a caller merging two efforts must qualify first" —
and `worktree.ts` is such a caller, because worktrees persist across invocations while the blocking
graph does not. Two efforts holding a ticket with the same number, title and bug label therefore
produce one branch name at one path, and starting the second attaches to the first's worktree and
hands the session the wrong task.

## What was rejected

**Putting the effort into the reference** — `md:<effort>#<key>`, filling the `repo` field that
markdown alone leaves null. It closes the collision properly and would make markdown exercise the
same repo-scoped path the trackers use. It was rejected because `TicketRef.repo` means *repository*
to the three trackers, and giving it a second meaning for the fourth is the one-name-two-readings
failure this project's design rules single out. The next reader gets whichever meaning they meet
first.

That trade would be worth revisiting only if a tracker turns out to need a scope that its remote
cannot supply. Jira is the candidate, and scope binding already answers it from user-level config
rather than from a reference.

## Consequences

Two efforts under one `.scratch` is now a refusal naming both and saying to keep one. That is a
narrower tool than before: the configuration was accepted, and any ticket set relying on it has to
move an effort to another checkout.

The reachability warning keeps its "holds N efforts" arm even so. This constrains the checkout the
command is invoked in; the branch it checks out is free to carry a second effort that the invoking
checkout does not have.
