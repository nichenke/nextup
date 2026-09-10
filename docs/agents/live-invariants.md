# The live invariant check

`bun run check:live` reads a real repository's ticket set through the adapter and checks the answer against
the tracker's own account of the same tickets. It is the cross-check issue 26 asked for, and ADR-0033 is why
it is built the way it is.

Local and manual. It needs a credentialed `gh`, it makes one call per open ticket, and CI runs with no
credentials by design — so it is not part of `bun test` and never will be.

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

## The ten checks

The first five are properties of one read. The sixth is the comparison everything else exists to make
trustworthy. The last four are the states issue 26 named as the ones that change the answer.

| Check | What it asserts |
| --- | --- |
| `whole-set-read` | The read covers the same window the independent query did: untruncated, undegraded, open tickets only, and the same count |
| `references-parse` | Every reference the read produced is one `resolveTicketRef` takes back, without asking a tracker |
| `blockers-resolve` | Every blocking edge names a ticket in the set or one outside it that still carries a state |
| `counts-reconcile` | Every ticket was placed exactly once, and the candidate partitions add up |
| `nothing-blocked-is-recommended` | Nothing the answer offers is a ticket the tracker says waits on something still open |
| `frontier-agrees` | The frontier the adapter derived is the one the tracker reports, both directions |
| `claimed-leaves-frontier` | A claim takes its ticket off the frontier |
| `closed-blocker-unblocks-its-dependent` | A closed blocker stops gating, rather than being counted as a blocker |
| `blocker-outside-the-set` | A blocker the read never returned still carries the openness its edge named |
| `unknown-blocking-is-not-an-empty-list` | A response with no blocking field reads as unknown, never as no blockers |

## Reading a verdict

**`held`** names what it read, not just that it passed. `references-parse: 17 references re-parsed` is the
evidence; a check reporting a pass over nothing is the failure this harness exists to catch, so there is no
such line.

**`unexercised`** means the repository produced nothing for the check to read, and it exits 1 rather than 0.
It is not a pass. Either the repository is too simple — nothing claimed, no closed blockers — or the adapter
stopped producing the state, which is a defect that would otherwise hide as a green run. Check which before
reaching for a different repository: an `unexercised` line arriving where the same repository used to
exercise the check is the more interesting of the two readings.

**`failed`** lists every ticket it disagreed about, one per line.

- `whole-set-read` failing first explains the rest, and the everyday cause is not a defect: a ticket opened
  or closed between the independent query and the adapter read leaves the two counting different sets. Rerun
  once before investigating. A failure that survives a rerun is a real one.
- `frontier-agrees` failing while `whole-set-read` holds is the finding worth having. One side has a ticket
  the other does not, and the line says which side. Read it with the four state checks: a disagreement
  alongside a failing `claimed-leaves-frontier` points at the claim, alongside a failing
  `closed-blocker-unblocks-its-dependent` at the blocking read.
- `unknown-blocking-is-not-an-empty-list` failing is the collapse `CONTEXT.md` forbids, reached live. An
  absent blocking field came back as a confirmed absence of blockers, so every ticket in the set would be
  recommended as confirmed-unblocked on no evidence.

## Adding a tracker

`LiveTracker` in `src/live-invariants.ts` is the seam: a name, an independent `observe`, the adapter's `read`,
and a `readBlind` that answers the same read with no blocking field. Supply those four and every check above
applies unchanged — that is what issue 26 meant by parameterised by tracker, and what tickets 15 and 17 are
meant to reuse.

Two things a new tracker has to get right, both of which ADR-0033 argues:

- **`observe` must share no code with the adapter.** Not merely be a second call — a different surface, a
  different field for each fact, a different parser. `src/github-live.ts` reads REST where the adapter reads
  `gh issue list`'s GraphQL projection, takes the repository from `repository_url` where the adapter takes it
  from the issue's own address, and asks a per-issue dependency endpoint where the adapter reads a bulk field.
- **`observe` must throw rather than degrade.** An expected answer holding `"unknown"` disagrees with nothing.

`expectedFrontier` reads one hop, which is correct for a tracker where containment does not gate its children
— ADR-0017 for why that holds on GitHub. A tracker whose parent chain does gate needs its own expected
frontier rather than this one.
