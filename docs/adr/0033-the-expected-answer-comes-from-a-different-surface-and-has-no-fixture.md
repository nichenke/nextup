# The expected answer comes from a different surface, and has no fixture

The reconstruction (`CONTEXT.md`) derives its expected frontier from a tracker surface the adapter does not read, with
code the adapter does not share. That independent reader has no stored recording behind it, and no test
asserting a successful observation. Its correctness is established by the comparison it takes part in, not by a
fixture.

Three decisions, and they are one: the surface, the absent fixture, and what replaces the fixture.

## Why a different surface rather than a second call

Issue 26 asks for an expected answer derived "independently of the adapter — a separate query, not a second
trip through the same parsing code". A second call through the same parser reproduces whatever the parser gets
wrong on both sides of the comparison and reports agreement.

So each fact is read somewhere else:

| Fact | The adapter | The independent reader |
| --- | --- | --- |
| The ticket set | `gh issue list --json`, GraphQL | `repos/{repo}/issues?state=open`, REST |
| A ticket's repository | the issue's own web address | `repository_url` |
| Blocking edges | the bulk `blockedBy` projection | `issues/{n}/dependencies/blocked_by`, one call per ticket |
| A blocker's repository | the blocker's web address | `repository.full_name` |
| Open or closed | `OPEN` / `CLOSED` | `open` / `closed` |

`docs/agents/issue-tracker.md` measures the per-issue dependency endpoint and `--json blockedBy` as the two
surfaces that answer authoritatively on the first read, which is what makes either usable as the other's
check. The one call per ticket is why this is a manual target: it is a cost worth paying rarely and not one to
put in `bun test`.

Two facts are read the same way on both sides, deliberately. The label filter is one compiled specification,
because what is under test is the read and a second implementation of the filter would measure the filter. The
label *values* it decides over are read separately, so a misread of a label the filter turns on still surfaces —
and only of such a label, since `admits` consults nothing else. `ticketId` is the other:
it is how the two sides' references are lined up at all.

## Why the independent reader has no fixture

CLAUDE.md's provenance rule says a recording comes only from the test tree, and ADR-0019 forbids inventing a
shape a capture could have supplied. Between those two, the reader's options were to add captures of both REST
endpoints to `bun run capture:github`, or to have no fixture. It has none.

The reason is that every way this reader can be wrong already surfaces as a failing check:

- It drops or invents a ticket — `whole-set-read` compares the two counts.
- It misreads an assignee, a blocker's state, or a label the filter decides on — the expected frontier moves and
  `frontier-agrees` reports which side has the ticket.
- It misreads a repository — the references stop lining up under `ticketId`, and the same check fires on both
  sides at once.
- It cannot read a response at all — it throws, and the run exits 2 rather than reporting a check.

Every degenerate output disagrees with a correct adapter, so a fixture would buy a sharper error message for a
class of defect that is already loud.

What that argument does **not** establish is that a false pass is impossible. Sharing no code makes the two
unlikely to be wrong in the same way; it does not make their *data* independent. Two sides that both lose the
same edge derive the same frontier, agree, and every check comparing an *outcome* is blind to it. That is why
`edges-agree` compares the two sides' edge sets directly rather than only their frontiers — an input comparison
is the only thing that sees a correlated loss. A total correlated loss is caught twice over, since
`blockers-resolve` and `edges-agree` both then report `unexercised`.

On the GitHub path today the partial case is unreachable, because the adapter reads an absent `blockedBy` and a
short node list as `"unknown"` rather than losing an edge into an empty list. That protection lives in the
adapter, though, not in this check, which is why `edges-agree` is worth its calls.

That argument does not extend to the adapter, and must not be read as weakening ADR-0019. The adapter's output
is shipped behaviour with no second opinion beside it; this reader is one half of a comparison whose other half
is independently derived, and it runs only when a person runs it.

The cost is real and worth naming: a defect here reports as a disagreement about the *adapter*, and the first
reading of a `frontier-agrees` failure will sometimes be wrong. `docs/agents/reconstruction.md` says to rerun
before investigating, which is the cheapest way to separate the common causes.

## Why an unexercised check fails

A check whose state the repository never produced reports `unexercised`, and that exits 1 with the failures.

Reporting it as a pass is the exact mistake this harness exists to correct. Ticket 05 shipped 199 tests over
fifteen review rounds and a single live run found a defect none of them had met; a coverage check that reports
green when it met nothing reproduces that at one remove. The reading is also ambiguous in a useful way — a
repository too simple to claim anything, or an adapter that stopped producing the state — and the ambiguity is
worth surfacing rather than resolving wrongly in the silent direction.

## Why the read-only guard is code

`readOnlyRunner` refuses any command that is not one of three reads, before it is issued, rather than the
check simply not containing a write. Issue 26 requires that it writes nothing to any tracker, and a property
enforced at the seam survives an edit that a comment does not. It is an allowlist because `gh` grows
subcommands: a denylist admits every write nobody anticipated, and an allowlist that falls behind only refuses
a read somebody has to add deliberately.

The `gh api` entry covers the whole endpoint space, so its flags are allowlisted too: a call there may carry
`--paginate` and `--slurp`, and nothing else beginning with `-`. Naming the writing flags instead was tried and
is not sound. `gh` uses pflag, which takes a shorthand's value attached and clusters boolean shorthands, so
`gh api -XPOST`, `-fkey=value` and `-iXPOST` each carry a method or a field while matching no flag name exactly
or before an `=`. All three were measured as parsing on gh 2.100.0, and all three passed the per-flag version of
this guard. Allowlisting the two inert flags is a smaller thing to keep right than enumerating the rest.
