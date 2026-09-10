# A deadlock is named beside the answer, and no adapter refuses one

A ticket set whose tickets block each other in a loop is reported as such: the selector names each cycle
on a `deadlock: ` line, and under `--json` as `selection.deadlocks`. It is reported *beside* whatever the
run answered — the pick, the ranking and the counts are unchanged by it, and a run holding a cycle exits
as it would without one.

This is what tells the two empty candidate sets apart. "Every candidate is blocked" is a fact about today
that a closing blocker fixes; "these tickets can never unblock each other" is a fact about the graph that
no rerun improves. Both used to render the same line, and a caller could not tell whether to wait or to go
and edit the tracker.

## Why the selector and not an adapter

Issue 7 refused blocking cycles inside the markdown adapter and then removed the refusal deliberately.
Both of its reasons still hold, and one of them is now the whole point:

- The propagation module is built to terminate on cycles, so refusing them in one adapter would make that
  tracker disagree with the others about which graphs are legal.
- Refusing took a whole effort down over one file — the same "no work available" symptom the diagnostic
  exists to prevent.

Telling a deadlock from an all-blocked backlog needs the whole graph, which only the selector has, so that
adapter was the wrong layer twice over — and it has since been deleted along with markdown
([0020](./0020-local-markdown-is-not-a-tracker.md)), which is why this decision is the deferral's only
surviving artifact. Detection runs over the `DependencyGraph` port in `src/deadlock.ts`: every tracker gets
it from one implementation, and GitLab and Jira will need nothing of their own.

## What a report claims, and what it prunes

A cycle is reported only where every ticket in it is confirmed open and every edge in it is one the
tracker reported. Both follow from what the line says: it says these tickets can never unblock, and an
unread edge could be the one that is not there. So an **Unknown** anywhere in a loop yields no report —
consistent with `effective-blockedness.ts`, where Unknown never becomes a confident answer in either
direction.

A cycle containing a closed ticket is not a deadlock. `deriveEffectiveBlockedness` prunes at a closed
blocker because a met dependency is met, and the ticket that was waiting on it is genuinely recommendable;
a check on the loop's edges alone would contradict the derivation one layer below it and report a deadlock
whose dependent the same answer recommends. A diamond is not a deadlock either, for the plainer reason
that a repeated visit is not a loop — both are pinned as scenarios rather than left to the reading.

Detection walks blocking edges and not the containment chain, which
[0017](./0017-containment-is-not-a-blocking-channel.md) closed: no adapter populates a parent, so the
ancestor walk `effective-blockedness.ts` inherited is inert and there is nothing there to loop through. That
is a scope limit worth stating rather than deriving, because reopening the containment channel would give
the two modules different answers about the same graph — the derivation would call a ticket blocked through
an ancestor's edge while this reported no cycle in it.

A ticket recorded as blocking itself is the one-member case and is reported. It is what a tracker permits
and a person writes by mistake, and it is the shape a "two or more" test would miss.

## One cycle per group, not every cycle

Where several loops interlock, the report names one shortest cycle through each ticket not already named,
rather than enumerating every cycle in the group — that enumeration is exponential in the worst case, and
a diagnostic that can bury the counts line is worse than one that is incomplete. Breadth-first, so each
report names as few tickets as any loop through the ticket it starts from can. That is not the smallest
loop in the group: with `a` blocked by `b`, `b` by `c` and `d`, `c` by `a`, and `d` by `b`, the reports are
`a → b → c` and `d → b`, the three-member one first. Edges are walked in graph-id order, so which of two
equally short cycles gets named is the same on every run and a fixture can assert it exactly.

That id is `ticketId`'s encoded tuple rather than a rendered reference, so it ranks `#10` before `#9` — a
determinism guarantee and not a readable one. Which is why the report is turned at the boundary instead:
`findDeadlocks` starts each cycle at its lowest reference and orders the cycles by that, through the same
`compareTicketRefs` the ladder's last rung uses. Turning a cycle costs nothing a reordering would, since every
ticket keeps the one blocking it next to it. Doing it in the walk was the alternative and would have put
reference order inside a module that holds only graph ids.

The accepted cost: in a group of interlocking loops, breaking the cycle the report names may leave another
behind, and the next run names that one. The alternative — naming the group's members without their edges —
gives a reader no path to follow through the tracker, which is the one thing the report is for.

## What it costs on a set with no deadlock in it

A walk per ticket is the obvious implementation and the wrong one: a healthy backlog reports nothing, so every
ticket pays a full traversal to find nothing. Which tickets can be on a cycle is a property of the strongly
connected components, so one pass over the edges answers it and the walks start only at tickets in a component
larger than one, or blocking themselves. That is exact rather than a heuristic — every cycle through a ticket
lies inside that ticket's own component — so the report is unchanged.

Measured on this branch with `bun`, over graphs built by `seedGraph`, before and after that pass:

| Shape, no cycle anywhere | Walk per ticket | Component gate |
| --- | --- | --- |
| 1,000 tickets, each blocked by 20 | 202ms | 3.5ms |
| 1,000 tickets, ~500,000 edges | 851ms | 61.7ms |

Holding each ticket's confirmed blockers for the length of one call is worth a further 26.8ms → 10.0ms on a
thousand tickets in a single component, and 104.8ms → 61.7ms on the dense set, because the graph implementation
in use copies each list on the way out — which the port itself does not promise either way. These are figures to compare against each other on one machine, not budgets, and no
benchmark ships — `nichenke/nextup` issue 58 records what is left and why it is below the scale of any current
use. The default window is 199 open tickets, where the same work is single-digit milliseconds.

## Consequences

`Selection.deadlocks` is its own field and not a `Degrade`. A degrade says the answer is worth less than a
confident one, and calls for a narrower query or a look at the tracker; this answer is confident, and calls
for a person to break a loop. Folding the two would have a script keyed on `degraded` retry a condition
that no retry changes.

Edges are followed only within the tickets the read returned. A cycle through a ticket outside it cannot be
confirmed anyway — a blocker that arrived only as somebody's edge carries its own state and no edges of its
own — and a report naming it would name a ticket the answer has no reference for. So a cycle that leaves
the read window is not detected, and the truncation sentinel is what says the window was short.

`deadlocks` carries no **Unknown**, and that is not the collapse it looks like. An empty list means no cycle
was *confirmed*, which is also what a set holding an unread edge produces — but such a set never reaches a
reader unannounced, because the read reports every row whose blockers it could not get as
`unreadable-blocking`, candidate or not. So the pair of lines is what carries the third state: no deadlock
line and no degrade is a confident "no cycle here". A `SelectionInput` hand-built with unknown edges and no
read degrade would say otherwise, and nothing in the read path builds one.

A cycle names at least one ticket by type — `NonEmpty<TicketRef>` — rather than by a check at the render
boundary. An empty cycle is a deadlock report with no tickets in it, which reads as a claim with nothing to
act on, and the render path would have to assert its way past it.

Detection runs over every ticket, not every candidate. An excluded or claimed ticket still blocks
(`CONTEXT.md`), so a cycle among tickets nothing may recommend is exactly the one the counts cannot explain
on their own.

The cost of that is a line on every run for a cycle among excluded tickets that gates no candidate, which
`--exclude` cannot silence — the flag narrows what may be recommended, never what the graph reads. Reporting
only cycles that gate a candidate was the alternative and is worse: a loop is a loop from the moment it
exists, and staying quiet until it blocks something means first reporting it on the run where it costs a
pick. Between the two, [0031](./0031-the-default-candidate-exclusions-are-negative-filters.md) makes the
noisy case likelier than it looks, since `spec` is excluded by default and a specification's own tickets are
where a stray edge is cheapest to write.
