# Local markdown is not a tracker

Local markdown is removed as a tracker, and no prose blocker parsing survives anywhere in the tool.
Blockers come from a tracker's structured links or they resolve to `Unknown`.

## Why the format goes

The four markdown ADRs this supersedes carry the evidence in full; the tally below is a pointer into them, not a substitute:
[0008](./0008-markdown-grammar-is-closed.md), [0009](./0009-block-structure-comes-from-a-commonmark-lexer.md),
[0010](./0010-the-markdown-reader-infers-nothing.md), [0012](./0012-claiming-overwrites-the-markdown-status.md).

Between them they record nine block-grammar divergences, three further rounds on inline grammar, a
discarded table row, and five or more filesystem-shape cases that were still arriving when this decision
was taken. The decisive record is in ADR-0010: over seven review rounds the blocker detector accumulated
six heuristics, and a final round "found holes in every one of them, in both directions at once" —
silently dropping real blockers while falsely refusing a ticket whose text read only `Blockers`. Its
conclusion is the general one: "guessing intent is not a thing that converges."

ADR-0010 also states the argument for removal better than this ADR would: effort spent inferring intent
from markdown text "buys nothing for the three adapters still to come, and the risk it was buying down is
a risk only markdown has."

## Why no prose fallback survives either

The spec asked for a `Blocked by:` line parsed out of an issue body, as the second rung of a fallback
ladder for a repository whose dependencies API is unavailable. That premise does not hold. The endpoints
carry no documented opt-out, the only issues-related repository toggle is whether issues exist at all,
and every repository probed — seven of the author's own plus a third-party public one — answered healthily,
with real edges in four of them. The ladder was protecting against a condition that does not occur.

A narrowed one-line grammar was considered and rejected. It is the same open-ended surface at smaller
scale: the moment it exists, a reviewer can reasonably ask about a synonym, a table cell, or a comment,
and each question is legitimate. Having no prose path to widen is worth more than having a narrow one to
defend.

## Consequences

`Unknown` survives and remains uncollapsible, but its sources change. It now arises from an outage, from
a truncated fetch, and from a documented gone response — never from a tracker lacking the feature.

The tool's only runtime dependency existed to lex markdown and goes with it.

There is no working command until the GitHub adapter lands. That gap is accepted: the markdown-only
command was not useful, so nothing is lost by having none for a while.

The superseded ADRs are kept, not deleted. They are the justification for this decision, and removing
them would leave it asserted rather than argued.

Numbers 0014 and 0015 are permanently unused. Both were markdown ADRs written on the branch behind a
closed pull request, and reusing spent numbers is worse than a gap.

The rule that governed which markdown shapes were legal is replaced, and strengthened, by
[0019](./0019-every-recording-is-captured-from-a-test-tree.md).
