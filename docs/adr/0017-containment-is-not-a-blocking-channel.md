# Containment is not a blocking channel

GitHub sub-issues are pervasive in the repositories this tool selects from — eighteen of twenty-four
issues here have a parent, and one surveyed repository has a parent on a hundred and twenty-eight of a
hundred and forty-four. The propagation module copied verbatim under
[docs/adr/0007-propagation-module-copied-verbatim.md](./0007-propagation-module-copied-verbatim.md)
walks containment ancestors and consults their open blocking edges, so a ticket inherits its parent's
blockers.

That channel stays closed. The parent field is never populated, and only explicit ticket-to-ticket
edges block.

Two reasons. The first is consistency with a decision already taken: sequencing intent lives in blocking
edges, which is why map parsing of any kind is out of scope. Containment inheritance is structural
sequencing, the same family. The second is that the ancestor walk consults an ancestor's edges without
checking whether the ancestor is closed, and closing an issue does not clear its dependency links — so a
finished parent carrying a link to a still-open blocker marks every descendant blocked. The tool would
then never offer that subtree, with no error and no way to notice. Both ingredients already exist in
these repositories independently: two surveyed repositories contain a closed issue still linked to an
open blocker, and parents with many children are everywhere. They have not yet co-occurred.

## Consequences

The ancestor walk in the copied module is inert by construction rather than removed, so the copy stays
verbatim and ADR-0007 holds.

An open epic's blocker does not reach its children. Where that matters the edge goes on the ticket
itself, where it is visible and machine-readable.

This is a first-pass decision and is expected to be revisited. If containment inheritance is wanted
later, the ancestor-closed check belongs upstream first, so that adopting it is still a copy rather than
a fork.
