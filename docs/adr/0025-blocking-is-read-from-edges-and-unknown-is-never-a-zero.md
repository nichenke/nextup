# Blocking is read from edges alone, and Unknown is never a zero

The GitHub read adapter takes blocking from the native dependency edges `gh issue list --json blockedBy`
returns, and from nothing else. It does not parse a `Blocked by:` line out of an issue body, and there is
no third source between the edges and **Unknown**.

`Unknown` for one ticket's blockers is reached two ways, both of them positive facts about the read:

- the call failed, which classifies as an outage and degrades every ticket in the read; or
- the response carried no blocking field for that row at all.

It is never reached from `{nodes:[],totalCount:0}`. That is what an issue with no blockers returns, and
reading it as Unknown would make every genuinely unblocked ticket unknown — the same collapse as the
opposite mistake, in the other direction.

## Why the body fallback goes

Issue 13's checklist asked for one: read the dependency endpoint, fall back to a `Blocked by:` line in the
body, resolve its references as issues or pull requests, and only then report Unknown. Three artifacts say
otherwise, and all three are newer than the checklist:

- The spec in issue 2, rewritten for real trackers: *"Blocking comes only from structured links… There is
  no prose fallback: nothing parses an issue body looking for a blocking declaration."*
- [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md): a failure on the dependency surface is an
  outage or a defect and gets surfaced, *"never degraded into a body line that something then has to
  recognise."*
- [0020](./0020-local-markdown-is-not-a-tracker.md), which removed prose as a source of blocking
  everywhere else, and which [0022](./0022-removing-markdown-left-three-earlier-decisions-partly-void.md)
  already read as voiding the decisions that rested on it.

So the checklist is a survivor of the markdown design rather than a requirement of this one. Building it
would have meant a grammar over free text, a resolution step for references that may be issues or pull
requests, and test-tree shapes to capture all of it from — for a condition that arises only when the
structured surface is unavailable, which is exactly when a body line is least likely to be maintained.

## Why an absent field is Unknown and an empty one is not

`blockedBy` carries no Unknown of its own. `docs/agents/issue-tracker.md` calls that a trap and says a
consumer's Unknown has to come from the call failing or from an explicit check, never from a zero. The
explicit check is the field's presence: a response listing rows that carry no `blockedBy` key is a read
of a projection that did not answer the question, and that is distinguishable from one answering *none*.

That shape is captured rather than imagined — `fixtures/recordings/github/ticket-set-without-blockers.json`
is the same query with the field left out of the projection, which is what a surface that cannot answer
looks like from the parser's side.

## Consequences

`Ticket.blockers` stays `readonly TicketRef[] | "unknown"`, and the adapter needs no new state.

A repository with issue dependencies switched off is not specially handled. If it returns rows with an
absent field, every ticket reads Unknown and the selector says so; if it returns empty edges, the tool
reads the repository as unblocked throughout, which is also what a repository with no dependencies
recorded looks like. The two are indistinguishable to us, and this decision does not pretend otherwise.

A blocker the read stopped short of still blocks, because each edge carries its blocker's own state. That
is the one place a ticket's openness is taken from something other than its own row, and it is confined
to blockers outside the read — a row that arrived is always its own authority.

One guard ships with no recording behind it: a node list shorter than the `totalCount` beside it is read
as Unknown, because it is a page of the edges rather than all of them. Reaching it needs more blockers on
one issue than the CLI returns at once, which the test tree cannot hold, and [0019](./0019-every-recording-is-captured-from-a-test-tree.md)
takes that inability as information rather than as licence to hand-write the shape.
