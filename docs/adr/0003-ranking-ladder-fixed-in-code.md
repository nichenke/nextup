# The ranking ladder is fixed in code, not configurable

Three prior implementations ranked three incompatible ways: critical-path depth parsed from prose in a
map issue, a bespoke tier enum requiring a project board, and whatever order the API happened to return.
`nextup` uses one fixed ladder — priority signal, then how many other tickets this one unblocks, then
ascending normalized reference — with each rung skipped when its signal is absent and the final rung
guaranteeing a total order.

It is not configurable, and no model participates in the decision. A configurable or model-assisted
ranking cannot be asserted against a fixture, which removes the only mechanism for learning that the
rule is wrong: when it picks badly, a scenario is added, watched to fail, and the rule is fixed. Adding
a knob later would invalidate the meaning of every golden fixture, so this is deliberately not one.

## Consequences

The final rung is the whole reference, not the ticket number. A number is not unique once a query spans
projects — two projects each have a ticket 1 — so a number-only rung returns equality on a tie and hands
the decision to tracker response order, which is the exact non-determinism this ADR exists to prevent
and would quietly make every golden fixture meaningless. A reference is unique by construction. Its
numeric part is compared numerically rather than lexicographically, so ticket 9 still precedes ticket 10.

This rung is not "oldest first", and earlier drafts of the spec and README wrongly described it that
way. A number approximates age only within a single project, and only where numbering is sequential. A
true creation timestamp was considered and rejected: three of the four trackers can supply one, but
local markdown cannot, and file modification time does not survive a checkout — a key that works
everywhere beats one that degrades on the backend shipping first.

A ticket whose blocking state could not be determined sorts last within its rung, so it surfaces only
when nothing confirmed-unblocked exists.

Ranking reads no map artifact of any kind. Sequencing intent must be expressed as blocking edges, where
it is machine-readable, rather than as a wave table or a longest-chain line in prose.
