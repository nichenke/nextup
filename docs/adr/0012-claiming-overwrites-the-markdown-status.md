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

While a ticket is claimed its triage role is not readable from the file, so a label filter cannot see
it. That is bounded: a claimed ticket is not a candidate, so the filter has nothing to decide about it.

The release path restores the previous file contents exactly, which is why the claim step holds the
text it overwrote rather than reconstructing a value. It refuses to restore over a file edited since
the claim: a ticket left claimed is visible and correctable, and a discarded edit is neither.

This asymmetry stays local to markdown. The three trackers that follow record a claim as an assignee
alongside labels and state, and none of them loses anything by claiming — so nothing above the adapter
should be written as if claiming costs information.
