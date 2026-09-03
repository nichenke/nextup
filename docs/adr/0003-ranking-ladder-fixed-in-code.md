# The ranking ladder is fixed in code, not configurable

Three prior implementations ranked three incompatible ways: critical-path depth parsed from prose in a
map issue, a bespoke tier enum requiring a project board, and whatever order the API happened to return.
`nextup` uses one fixed ladder — priority signal, then how many other tickets this one unblocks, then
oldest first — with each rung skipped when its signal is absent and the final rung guaranteeing a total
order.

It is not configurable, and no model participates in the decision. A configurable or model-assisted
ranking cannot be asserted against a fixture, which removes the only mechanism for learning that the
rule is wrong: when it picks badly, a scenario is added, watched to fail, and the rule is fixed. Adding
a knob later would invalidate the meaning of every golden fixture, so this is deliberately not one.

## Consequences

A ticket whose blocking state could not be determined sorts last within its rung, so it surfaces only
when nothing confirmed-unblocked exists.

Ranking reads no map artifact of any kind. Sequencing intent must be expressed as blocking edges, where
it is machine-readable, rather than as a wave table or a longest-chain line in prose.
