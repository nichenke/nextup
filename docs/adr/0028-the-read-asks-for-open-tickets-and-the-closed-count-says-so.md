# The read asks for open tickets, and the closed count says it never asked

The GitHub read asks `--state open` rather than `--state all`, bounded by a limit the command defaults to
199. `SelectionCounts.closed` reports `"not-asked"` under such a read rather than a zero, and the selector
refuses a closed ticket in a set read that way.

The three are one decision. Dropping closed rows is what makes the count a lie, so the count's
representation is part of the price of the filter rather than a separate question.

## Why the filter changes

`gh issue list` orders by creation date descending. Measured rather than assumed: a read of this
repository's own issues comes back in strict `createdAt` order while `updatedAt` jumps around inside it. So
under `--state all` the row limit is spent on what was *created* most recently, including tickets nothing
could ever recommend.

Worth stating narrowly, because the obvious wider claim is false. Closing an old ticket does not move it
onto the newest page, so a repository working through a long backlog loses nothing under `--state all`. What
loses is a repository that *creates and closes* quickly — short-lived tickets, bot-filed ones, anything with
high issue throughput. There the newest rows are mostly closed, the open frontier truncates away, and the
answer is correct and useless: a pick from the handful of open tickets that fit, while the ones that did not
fit are the reason to run the tool.

### Who loses under this scheme

Naming this side too, because the argument above only names who loses under `--state all`. A repository with
more open tickets than the limit gets a window of the newest-created ones, so its *oldest* open tickets are
never candidates — and no number of runs changes that, since the window is deterministic. A `P0` filed a
year ago and never worked is invisible while 199 newer tickets exist.

That cuts against the ladder, whose last rung breaks ties by ascending reference: it prefers the oldest
ticket of an otherwise equal pair, and the read drops exactly those first.

It is still the right window, and the alternatives were checked rather than assumed. `gh issue list` has no
sort flag; ordering is reachable only through `--search`, whose sorts are `created`, `updated`, `comments`
and `reactions` — none of which is the ladder. Taking `sort:created-asc` would invert the bias to hide all
recent work, which is worse for a tool answering "what next". So the window stays newest-first and the cost
is stated instead: the truncation sentinel says the answer may be missing a better candidate.

The only remedy that widens the window is a larger `--limit`. `--include` is **not** one, and saying it was
is a mistake this ADR carried until a reviewer caught it: the label filter is compiled in the command and
applied to the rows already returned, so it narrows what may be recommended from inside the window and
cannot reach a ticket the read never fetched. The section below is what would have to change first.

Reading open-only spends the whole limit on the population a pick can come from. Nothing else about the
answer changes, and blocking in particular does not, because a blocker's state arrives on its dependent's
edge. Measured against the tree, an open-only read returns `#9:CLOSED` on the edge of both tickets that
depend on it.

The *seed* is not identical, and the difference is worth being exact about: from a row, `graphFor` seeds a
blocker's own blockers, and from an edge it seeds them `"unknown"`.

That `"unknown"` is honest bookkeeping rather than a load-bearing safety property, and saying so precisely
matters, because this is the artifact someone will consult before making dependency blocking transitive.
`deriveEffectiveBlockedness` enqueues only containment parents, never a dependency blocker: a confirmed-open
blocker returns `blocked` immediately, and a closed one is pruned. So a blocker's own blockers are never
read, whichever way it was seeded, and the field is inert today. A transitive walk would remove that
short-circuit — and then the `"unknown"` starts deciding answers, for every blocker the read did not return.

## What is given up, precisely

A row is the tracker's own per-ticket state, and an edge is one dependent's view of it, so ADR-0027 has
rows beat edges where both exist. An open-only read has no closed rows, so a closed blocker's openness now
rests on the edge alone.

That is a narrower loss than it first looks, and in the safe direction. Row-over-edge precedence still
covers every *open* blocker in the read — which is the direction that matters, because an edge wrongly
claiming a blocker is closed is what would recommend a blocked ticket. What is given up is the reverse: an
edge wrongly claiming an open blocker where the ticket is closed now over-blocks, and the tool skips
something startable instead of handing out something blocked.

Two consequences of that are worth naming rather than leaving inside "the safe direction", because both are
quiet:

- **The skip carries no sentinel.** An edge wrongly reporting an open blocker makes its dependent read
  `blocked`, which is a *confident* state and so emits no degrade. If that dependent was the only candidate,
  the run prints "no candidate to recommend" with no `degraded: ` line at all, so there is nothing to grep
  for. The counts line does still tell the two apart — `1 candidates (0 unblocked, 0 unknown, 1 blocked)`
  against `0 candidates` for an empty backlog — so the gap is the machine-readable signal, not the
  information.
- **A disagreement between two edges now degrades the answer.** With closed blockers as rows, `graphFor`
  discarded every edge naming one, so two dependents disagreeing about a blocker was impossible. Outside the
  read, disagreement seeds the blocker `"unknown"`, both dependents derive `"unknown"`, and if nothing else is
  confirmed the whole selection is reported as degraded. The row used to settle it.

`docs/agents/issue-tracker.md` measures the surface this rests on. `--json blockedBy` returns each blocker
with its own state and was observed to be correct in the same window where
`issue_dependencies_summary` reported a stale `0` — so the edge state here is the one dependency surface
that was tested against a lag and had none in it. That measurement is why this is not a coin-flip.

## Why the counts cannot just report zero

Under an open-only read `closed` is zero whatever the tracker holds. A reader takes a zero as a count, and
the count they would read is "this repository has no closed tickets" — which is the collapse `CONTEXT.md`
forbids for blocking, arriving in the one other place a zero can mean "never asked".

So `SelectionCounts.closed` is `number | "not-asked"`, `SelectionInput.openOnly` is required for the same
reason `truncated` is, and `TicketSetRead` reports which kind of read produced it rather than leaving a
caller to restate it. A set that is open-only *and* holds a closed ticket is refused: taking it would print
`closed not asked` beside tickets that are closed, denying what the set in front of it holds.

The rendered line reads `14 tickets: closed not asked, 0 claimed, ...`.

### What this does not generalize to

`closed` gets a sentinel; `filtered` and `claimed` do not. That asymmetry is load-bearing only while the
label filter and the claim check run *locally*, over rows the read already returned — there, a zero is a
count.

The moment a filter moves into the query, it stops being one — and there is a standing reason to move one.
Making `--include` reach work outside the newest-N window means pushing it into the `gh` query, at which
point `SelectionCounts.filtered` is zero whatever the tracker holds: this same collapse, in a field with no
sentinel, no required input flag and no guard. `--assignee` would do it to `claimed`.

So the next person to push a filter server-side should carry the read's asked-for scope once — the states,
the labels, the assignees — and derive from it which count fields may report a number, rather than writing
this three-part fix a second and third time. Doing that now would be building for a query nothing sends;
writing it down costs nothing and is the difference between generalising the mechanism and adding a fourth
special case.

## Why 199, and why the command defaults it at all

The adapter still refuses to default a limit — a default is a claim about somebody's backlog, and the
adapter has no standing to make one. The command does, because a bare `nextup` is what the spec's user
stories ask for, and a tool that demands a row count before it will answer is not that.

The claim it makes is that a repository with more than about two hundred *open* tickets is one whose oldest
open work this tool will not consider until asked. A read that hits the limit reports itself truncated rather
than answering as though it were whole, and a bigger `--limit` is what answers that — see above for why
`--include` is not, despite what this section said until a reviewer caught it.

199 rather than 200, because the read asks for one row more than the limit to detect a cap, and `gh` pages
at a hundred. Measured against a large repository with `GH_DEBUG=api`: `--limit 200` costs two GraphQL
requests, `--limit 201` costs three — the third fetching the single probe row and then discarding it. A
limit of 200 would therefore pay a full extra round-trip on every truncated read, which is exactly the case
the sentinel exists for. One below the round number keeps `limit + 1` inside the same page count as the
limit itself, and costs one ticket of consideration.

## Consequences

The replay corpus was recaptured, and the captures now bound their row count by the tree's open issues
rather than by every issue it holds. `closed-blocker` is no longer reachable as a ticket in a recorded
read — it is reachable only as a blocker on an edge, which is what the tests assert about it now.

A tracker whose blocking edges do not carry the blocker's state cannot be read this way. That is a
constraint on the GitLab and Jira adapters rather than an assumption they inherit: an adapter whose edges
carry only a reference has to read closed tickets as rows, and it then reports `openOnly: false` and gets a
real count.
