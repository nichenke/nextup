# Reconstruction

`CONTEXT.md` defines **reconstruction** as reading a real repository live and asserting invariants over the
result rather than exact values — the primary control, because it is the only one that finds shapes nobody
imagined. `bun run check:live` is that control, and ADR-0033 is why it is built the way it is.

Local and manual. It needs a credentialed `gh`, it makes a request per open issue to read that issue's
blockers, and CI runs with no credentials by design — so it is not part of `bun test` and never will be.

```sh
bun run check:live                        # the repository the working directory's origin points at
bun run check:live --repo owner/name      # some other repository
```

It writes nothing. Not to a tracker — `readOnlyRunner` refuses any command that is not a read, before it is
issued — and not to disk, because peer sessions commit in shared worktrees and would sweep up a report file.
The whole answer goes to stdout.

Point it at a repository nobody built for it. That is the entire value: a synthetic tree puts shapes where
its author expected them, and this exists to meet the ones a real producer creates. `nichenke/nextup` itself
is the obvious target; the test tree is a valid argument and a nearly worthless one.

## What it exits with

| Status | Meaning |
| --- | --- |
| 0 | Every check ran and held |
| 1 | A check failed, or the repository never produced the state it needed |
| 2 | The run could not be made — no repository, an unreachable tracker, a response nothing could read |

## The eleven checks

Checks two and three are properties of one read. Checks one and four to seven are comparisons against the
independent query — the ones the rest exist to make trustworthy. The last four are the states issue 26 named as
the ones that change the answer.

| Check | What it asserts |
| --- | --- |
| `whole-set-read` | The read covers the same window the independent query did: untruncated, undegraded, open tickets only, and the same tickets on both sides and in the blocking-field-less read |
| `references-parse` | Every reference the read produced is one `resolveTicketRef` takes back, without asking a tracker |
| `blockers-resolve` | Every blocking edge names a ticket in the set or one outside it that still carries a state |
| `counts-reconcile` | Every ticket was placed under the placement the tracker's own claim and labels call for, compared per ticket and not only as bucket totals |
| `nothing-blocked-is-recommended` | Nothing the answer offers is a ticket the tracker says waits on something still open |
| `edges-agree` | The two sides read the same blocking edges, with the same openness — the one check comparing inputs rather than outcomes |
| `frontier-agrees` | The frontier the adapter derived is the one the tracker reports, both directions |
| `claimed-leaves-frontier` | A claim takes its ticket off the frontier |
| `closed-blocker-unblocks-its-dependent` | A closed blocker stops gating, rather than being counted as a blocker |
| `blocker-outside-the-set` | Coverage only, with no fault of its own: that the read met a blocker it did not return, whose state `blockers-resolve` is what asserts |
| `unknown-blocking-is-not-an-empty-list` | A response with no blocking field reads as unknown, never as no blockers |

## Reading a verdict

**`held`** names what it read, not just that it passed. `references-parse: 17 references re-parsed` is the
evidence; a check reporting a pass over nothing is the failure this harness exists to catch, so there is no
such line.

**`unexercised`** means the check did not compare anything, and it exits 1 rather than 0. It is not a pass.
Usually the repository produced nothing for it to read: too simple — nothing claimed, no closed blockers — or
the adapter stopped producing the state, which is a defect that would otherwise hide as a green run. Check
which before reaching for a different repository: an `unexercised` line arriving where the same repository used
to exercise the check is the more interesting of the two readings.

`frontier-agrees` reports it for the other reason — the two frontiers cannot be compared whole. That happens when
candidates came back with unknown blocking, and also when the read could not read a blocking field on a ticket it
placed by claim or label first: such a ticket never becomes an unknown candidate, so the candidate count alone
would have called this comparable when it was not. Its line says which of the two, and how many.

**`failed`** lists every ticket it disagreed about, one per line.

- `whole-set-read` failing first explains the rest, and its everyday cause is not a defect: a ticket opened or
  closed between the three reads leaves them holding different sets. It names which ticket and which side, so
  rerun once before investigating; a difference surviving a rerun is a real one.
- Only one degrade fails this check: `the read did not complete`, which is the call itself failing. The others
  are the tracker answering with less than one answer in it rather than a defect, so `whole-set-read` names them
  in its `held` line — `degraded: contradicted-blocker` — and does not fault. `contradicted-blocker` is the one
  to expect on a healthy adapter: two edges disagreed about one blocker, and ADR-0027 has what the adapter does
  there. `partial-blocking` is a ticket whose blockers arrived as one page of a longer list, held out of the
  answer and not counted missing from it. Neither goes unnoticed: unreadable blocking leaves `frontier-agrees`
  unable to compare whatever the candidate count says, and a withheld ticket that the tracker would recommend
  still disagrees there.
- `frontier-agrees` failing is a real disagreement, naming the ticket and the side that has it; while
  `whole-set-read` holds it is the finding worth having. Read it with the four state checks: a disagreement
  alongside a failing `claimed-leaves-frontier` points at the claim, alongside a failing
  `closed-blocker-unblocks-its-dependent` at the blocking read. A read with unknown blocking and nothing to
  report makes it `unexercised` instead.
- `edges-agree` failing narrows a frontier disagreement to the edge it came from, and can fail where
  `frontier-agrees` holds — two edges wrong in compensating directions reach the same frontier. ADR-0033 has why
  an input comparison is not redundant with the outcome ones.
- `unknown-blocking-is-not-an-empty-list` failing is the collapse `CONTEXT.md` forbids, reached live. An
  absent blocking field came back as a confirmed absence of blockers, so every ticket in the set would be
  recommended as confirmed-unblocked on no evidence.

## Adding a tracker

`ReconstructionTracker` in `src/reconstruction.ts` is the seam: a name, an independent `observe`, the adapter's `read`,
and a `readBlind` that answers the same read with no blocking field. Supply those four and every check above
applies unchanged — that is what issue 26 meant by parameterised by tracker, and what tickets 15 and 17 are
meant to reuse.

Two things a new tracker has to get right, both of which ADR-0033 argues, with its table as the worked example:

- **`observe` must share no code with the adapter** — a different surface, a different field per fact, a
  different parser, not merely a second call.
- **`observe` must throw rather than degrade.** An expected answer holding `"unknown"` disagrees with nothing.

One limit on "unchanged": `expectedFrontier` reads a ticket's own edges and no further, which its docstring
argues is right wherever containment does not gate its children. A tracker whose parent chain does gate needs a
different expected frontier, and since `expectedFrontier` is private with no seam on `ReconstructionTracker` to override,
that means a change to `src/reconstruction.ts` rather than only a new implementation.
