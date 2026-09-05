# Claiming a markdown ticket overwrites its `Status:` field

A markdown claim is written as `Status: claimed`, replacing whatever that line said. Releasing the
claim puts the previous value back verbatim.

## Why

ADR-0010's table gives markdown one column for a claim — `claimed`, or its absence — and `Status:` is
the line it lives on. That same line also carries the ticket's open/closed state and its triage role,
because the format has one field where a tracker has three. So a claim cannot be additive here the way
an assignee is on GitHub, GitLab and Jira: writing one necessarily overwrites a `ready-for-agent` or an
`open`.

Three alternatives were considered and rejected:

- **A second field**, `Claimed by:` or similar. ADR-0008 closes the grammar to what the two authored
  producers write, and neither writes one. Adding a field to carry a claim would make this tool a third
  producer of a format it exists to read.
- **Refusing to claim a ticket whose status carries a triage role.** That is most of a real effort, and
  the refusal would land on exactly the tickets a run is most likely to pick.
- **Encoding both**, `Status: claimed ready-for-agent`. An unrecognised `Status:` value fails loudly by
  design, so this would have to widen the vocabulary combinatorially, and every reader of the format
  would have to learn the compound form.

## Consequences

A claimed ticket's triage role is gone from the file, and does not come back on its own. The release
path restores the previous contents exactly, but it runs only when a claim is given back — so a run
that claims successfully, and every run abandoned after that point, leaves the role overwritten until
somebody types it again. Nothing downstream misreads that, because a claimed ticket is not a candidate
and the label filter never sees it; the cost is to whoever reads the file afterwards.

This is the price of the one field, and it is why the alternatives above were weighed rather than
waved through. The check that would notice it is the live check of nichenke/nextup issue 26, which
compares a generated effort against the tracker it came from.

## What markdown cannot verify

The spec orders the claim step "claim, verify it landed and is mine". Markdown can answer the first
half and not the second: a `Status:` line has nowhere to put a name, so `Claim.by` is always null and
the file cannot say whose claim it is. Verification here checks that the claim landed, and the
re-read before the write refuses a ticket already claimed — together they stop this tool taking a
claim it can see, which is as close as the format reaches.

That is a property of markdown rather than a decision for the whole tool. GitHub, GitLab and Jira all
record an assignee, so each of those adapters owes the second half of that sentence: compare the
claimant the tracker reports against the identity the CLI is authenticated as, and refuse where they
differ. Nothing above the adapter enforces it, and `ClaimHold.claimant` is a `Claim` rather than a
name precisely so a tracker that records nobody cannot be read as nobody having claimed.

This asymmetry stays local to markdown. The three trackers that follow record a claim as an assignee
alongside labels and state, and none of them loses anything by claiming — so nothing above the adapter
should be written as if claiming costs information.
