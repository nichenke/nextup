# A closed ticket is closed, whatever closed it

A blocker that is closed no longer blocks. The reason it closed is not read, so a ticket closed as
`wontfix`, or as GitHub's `not_planned`, unblocks its dependents exactly as a completed one does.

This reverses the previous rule, under which such a closure made the dependent's blocking state
`unknown` so that it sorted below everything confirmed unblocked.

## Why the previous rule goes

Its only recorded justification was
[0010](./0010-the-markdown-reader-infers-nothing.md), which
[0020](./0020-local-markdown-is-not-a-tracker.md) supersedes. No ADR argued for it independently, and
`CONTEXT.md` never mentioned it.

It also contradicted the vocabulary it was written in. **Unknown** is defined as the state where *the
tracker could not tell us*. A `wontfix` closure is the tracker telling us plainly; calling it `unknown`
loads a second meaning — the tracker told us and we judged the answer unsatisfying — into the one term
the design exists to keep sharp.

And the mechanism was inference: the selector second-guessing a tracker's own canonical state from a
closure reason. That is the thing ADR-0010 concluded does not converge and ADR-0020 removed everywhere
else. It also contradicted the rule that a tracker's open/closed state is canonical.

The practical argument is simpler. If closing a blocker leaves what depended on it unstartable, the
repair belongs in the tracker — reopen it, or close the dependents. A selector that models the
disagreement instead is guessing at a judgment nobody recorded.

## Consequences

`Ticket.state` stays `"open" | "closed"`. Nothing in the normalized surface needs a third arm, and an
adapter has one fewer thing it can get wrong.

`open: ticket.state === "open"` is now the correct mapping into the graph, where it used to be the
canonical example of the collapse this project forbids. `seedGraph`'s warning is rewritten accordingly:
the remaining hazard is `blockers` read as `[]` when they were never read at all.

`GraphSeed.open`'s `"unknown"` means a failed read and nothing else, which is what **Unknown** says.

Scenario fixtures lose their `openness` key. That key defaulted to `state === "open"` when omitted, so a
fixture that forgot it silently asserted the opposite of what it meant — a defect that disappears with
the field rather than needing a guard.

The cost, stated plainly: a blocker closed as `wontfix` whose dependents genuinely cannot proceed will
make those dependents recommendable. The selector reports the pick's blocking state as `unblocked`, which
is honest but does not name which blocker cleared — so this wrong pick reads exactly like a right one, and
a session that wants to weigh closure reasons has to read the ticket's own blocker links to do it.
