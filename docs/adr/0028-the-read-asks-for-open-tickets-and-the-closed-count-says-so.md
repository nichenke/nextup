# The read asks for open tickets, and the closed count says it never asked

The GitHub read asks `--state open` rather than `--state all`, bounded by a limit the command defaults to
200. `SelectionCounts.closed` reports `"not-asked"` under such a read rather than a zero, and the selector
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

Reading open-only spends the whole limit on the population a pick can come from. Nothing else about the
answer changes, and blocking in particular does not, because a blocker's state arrives on its dependent's
edge. Measured against the tree, an open-only read returns `#9:CLOSED` on the edge of both tickets that
depend on it.

The *seed* is not identical, and the difference is worth being exact about: from a row, `graphFor` seeds a
blocker's own blockers, and from an edge it seeds them `"unknown"`. What is unchanged is the blockedness
derived from it, and only because a closed blocker is pruned before its own blockers are ever consulted. An
*open* blocker outside the read is a different case — there the `"unknown"` is load-bearing, and
`graphFor`'s own comment says so.

## What is given up, precisely

A row is the tracker's own per-ticket state, and an edge is one dependent's view of it, so ADR-0027 has
rows beat edges where both exist. An open-only read has no closed rows, so a closed blocker's openness now
rests on the edge alone.

That is a narrower loss than it first looks, and in the safe direction. Row-over-edge precedence still
covers every *open* blocker in the read — which is the direction that matters, because an edge wrongly
claiming a blocker is closed is what would recommend a blocked ticket. What is given up is the reverse: an
edge wrongly claiming an open blocker where the ticket is closed now over-blocks, and the tool skips
something startable instead of handing out something blocked.

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

## Why 200, and why the command defaults it at all

The adapter still refuses to default a limit — a default is a claim about somebody's backlog, and the
adapter has no standing to make one. The command does, because a bare `nextup` is what the spec's user
stories ask for, and a tool that demands a row count before it will answer is not that.

The claim 200 makes is that a repository with more than that many *open* tickets wants a narrower query
rather than a longer read. `gh` pages at a hundred and stops when the tracker runs out, so the second page
costs nothing where the repository holds fewer, and a read that hits the limit reports itself truncated
rather than answering as though it were whole. `--limit` overrides it; the honest response to seeing the
truncation sentinel is `--include`, not a bigger number.

## Consequences

The replay corpus was recaptured, and the captures now bound their row count by the tree's open issues
rather than by every issue it holds. `closed-blocker` is no longer reachable as a ticket in a recorded
read — it is reachable only as a blocker on an edge, which is what the tests assert about it now.

A tracker whose blocking edges do not carry the blocker's state cannot be read this way. That is a
constraint on the GitLab and Jira adapters rather than an assumption they inherit: an adapter whose edges
carry only a reference has to read closed tickets as rows, and it then reports `openOnly: false` and gets a
real count.
