# Removing markdown left three earlier decisions partly void

[0020](./0020-local-markdown-is-not-a-tracker.md) removed local markdown as a tracker and
[0021](./0021-a-closed-ticket-is-closed.md) reversed how a closure reason is read. Three earlier ADRs
contain clauses that depended on one or the other. Their bodies stand as written; this ADR records which
clauses no longer bind, and what replaces them.

## ADR-0007: the openness half of its collapse warning no longer applies

[0007](./0007-propagation-module-copied-verbatim.md) warns that an adapter reaching the graph store
directly can write `openness.set(id, ticket.state === "open")`, "which reads a blocker closed without its
dependency being met as satisfied", and calls that one of two collapses `CONTEXT.md` forbids.

ADR-0021 makes that mapping the **required** one: a closed ticket is closed whatever closed it.

The other half of 0007's warning stands unchanged and is still the reason `GraphSeed` exists —
`blockers.set(id, [])` for blockers never read type-checks and reports a confident `unblocked` where the
honest answer is that nothing is known. Read 0007's "all four trackers" as three.

This is the clause that matters most of the three: an adapter author following 0007's openness sentence
would reintroduce exactly the behaviour ADR-0021 removed.

## ADR-0001: its markdown clauses are void, its decision is not

[0001](./0001-scope-binding-in-user-config.md) infers "the markdown ticket directory from the tree", and
concludes that "GitHub, GitLab, and markdown stay zero-config". Neither clause survives; read the second
as GitHub and GitLab.

The decision itself is untouched — Jira scope binding in a single user-level file keyed on the normalized
git remote slug — as is every reason 0001 gives for it, including why per-repo config and a central
registry were rejected.

## ADR-0003: its rejection of a timestamp rung lost its reason, and the question is reopened

[0003](./0003-ranking-ladder-fixed-in-code.md) rejects a creation timestamp as a ranking key because
"three of the four trackers can supply one, but local markdown cannot". Every remaining tracker can
supply one, so that reason is void.

The terminal rung still stands, on the other argument in the same passage: a reference is unique by
construction, and the terminal rung has to be total, which a timestamp is not — two tickets can share one.

What is now open, and deliberately not settled here: whether a creation timestamp earns a rung *above*
the reference rung. 0003's own reasoning makes adding a rung a deliberate decision rather than a tuning
knob, so it needs its own ADR and its own scenario fixtures.

## Consequences

Those three ADRs keep their bodies and gain an `Amended by` banner. Nothing is rewritten, because an ADR
body is the record of what was decided and when — editing one so it agrees with a later decision destroys
the evidence that the decision ever changed, which is the only thing that makes the record worth keeping.

A reader arriving at 0001, 0003 or 0007 first meets the banner, so a stale clause is never read as current
without the correction attached.

The pattern is worth naming, because it recurred: each of these is a rule that outlived its
justification. All three were found by review rather than by the change that invalidated them, so a
decision that removes a subsystem should include a pass over what cited it.
