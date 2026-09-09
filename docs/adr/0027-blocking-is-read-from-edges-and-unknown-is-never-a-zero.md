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

Where two edges disagree about such a blocker, neither reading is taken and its openness is seeded
Unknown, which the read also reports. A read spanning more issues than the CLI returns at once is several
pages, so a blocker that closes mid-read can legitimately arrive open in one row's edges and closed in
another's. Keeping either would decide one ticket's blocking state from a different ticket's edge: the
first version kept the last, and reported a ticket unblocked whose own edge said its blocker was open.
Reading the pair as open instead is safe in that direction and wrong in the other, withholding work whose
blocker had in fact just closed — and **Unknown** is the term already reserved for the tracker not telling
us one thing.

A ticket whose blocker list arrives as a page — fewer nodes than the `totalCount` beside them — is **held out
of the answer**, and reported. Neither reading of that page is available: the edges that did arrive may hold a
confirmed open blocker, so Unknown demotes a confirmed block to a state the selector recommends from —
inverting, one layer below where it is implemented, the precedence `effective-blockedness.ts` enforces — while
the retained list read as complete is wrong in the other direction, since a missing edge may be the open one.

Refusing the whole read was the first answer to that and went too far: one over-linked issue made every other
ticket in the repository unreachable, with no limit or filter that got the caller any answer. The narrower
refusal is to judge that one ticket not at all. It still seeds the graph — its own row remains the authority on
whether it is open, so tickets blocked by it are unaffected — but it is never a candidate, and
`partial-blocking` names it. Paging the edges through `gh api graphql` is still the fuller fix, left until
something reaches this.

Reaching that shape needs more blockers on one issue than the CLI returns at once, which the test tree cannot
hold, so **no recording stands behind it** — [0019](./0019-every-recording-is-captured-from-a-test-tree.md)
takes that inability as information rather than as licence to write one. The behaviour is still asserted, from
an input built inline in the test: what that test claims is our own policy on an incomplete list, which holds
whoever produced it, and nothing about what GitHub returns. That distinction is the whole of what 0019 governs —
a stored recording asserts a tracker produces a shape, so it has to come from one; an inline input asserting a
refusal to conclude asserts nothing of the sort. The same reading covers the two edges that disagree about one
blocker, for the same reason.

Every row seeds the graph, including the row fetched only to detect truncation. `limit` bounds what may be
recommended, not what the graph knows: dropping a row from the graph leaves a dependent's edge — a copy, which
can be stale — answering for it, so where the page happened to end decided a ticket's blocking state. A first
version of the probe-row fix did exactly that, and a ticket whose blocker was open read unblocked at one limit
and blocked at the next.

A ticket's repository is read from its own row's address, never from what the caller asked for, because a
blocker's repository can only come from its edge's address and the two must agree. They did not: GitHub
repository paths are case-insensitive and a rename redirects, so `Example/Repo` and `example/repo` produced
different graph ids for one issue. A blocker that *was* in the read then looked outside it, took its
openness from a dependent's stale copy of it, and a ticket whose blocker was open read unblocked with
nothing flagged. It also silently zeroed the second ranking rung, since `countUnblocks` matches edge ids
against the read's own.

The host is checked before any read. A remote's host is not carried into the query — a read carries no
`--hostname` — so a checkout on GitHub Enterprise resolved to a bare `owner/repo` indistinguishable from a
github.com one, and the read answered about whatever public repository sat at that path. That is somebody
else's work presented as this project's, so a non-github.com origin is refused by name. Reading an
enterprise host is not supported rather than approximated.

Degrades are reported as kinds rather than sentences — `outage`, `unreadable-blocking`,
`contradicted-blocker` — matching how `Degrade` and `DEGRADE_REASON` already divide this repo: structure
inside, prose only at the render boundary. Prose built in the adapter had already pulled two tests into
asserting wording that `selection-output.ts` declares free to change, and it filed the contradicted-blocker
case under a word `failure-class.ts` reserves for connectivity and the tracker erroring.
