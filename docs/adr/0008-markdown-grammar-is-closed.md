# The markdown grammar is closed, because markdown is a test surface not a tracker

The markdown adapter accepts exactly the two field forms this project authors, and refuses every other
field-shaped line. It is not a general-purpose markdown consumer and will not become one.

## Why

The spec picks markdown for v1 to get "zero credentials and zero API archaeology, while exercising
every piece of the design" — reference parsing, the propagation module, the ranking ladder, the
launcher, CI. Markdown is the substrate that lets the *spine* be built and tested without a token. It
is not a product surface, and nobody hands this tool markdown from outside.

The spec then enumerates the format as a closed set: an H1 title, `Type:`, `Status:` and optional
`Blocked by:` lines, with `## Question` / `## Notes` / `## Answer` sections. Two authored producers
exist — the wayfinder local-markdown convention, which writes plain `Status:` lines, and the
`to-tickets` skill, which writes `**Status:**` in bold. That is the whole input population.

## What is accepted

- A ticket file at `issues/<NN>-<slug>.md`.
- One H1 title, optionally prefixed `<NN> —`.
- Field lines above the first `##` section heading, unindented and undecorated, plain or bold:
  `Type:`, `Status:`, `Blocked by:`.
- `Blocked by:` as bare comma-separated ticket numbers, or `None` with optional dash commentary.
- Anything else in the header region is prose, which is how `to-tickets` writes `**What to build:**`.
- Fenced code blocks are skipped, so a snippet may quote any of the above.

Everything else that looks like a blocker declaration is refused, loudly, naming the file: a bulleted
or blockquoted field, a table row, a definition list, an indented one, a `## Blocked by` heading, a
renamed `Blockers:` or `Depends on:`, one below a section heading. A `Status:` in any of those shapes
is ignored rather than refused — a missed `Status:` reads open and unclaimed, which a human sees at
the confirmation gate, whereas a missed `Blocked by:` reads a confident `unblocked`, the one state
`CONTEXT.md` forbids inferring.

## Consequences

This supersedes a run of five review rounds that widened the parser shape by shape — bullets,
blockquotes, tables, definition lists, setext underlines, alternate field names, indented blocks.
Each widening was a correct response to a real reproduction and three of them introduced a fresh
defect, twice reaching the forbidden collapse from the opposite direction. The lesson is not that the
sixth round would have finished the job: an open grammar over a format nobody constrains has no
finishing condition, and every accepted shape is a new way to be wrong.

So a review finding of the form "markdown shape X is not parsed" is answered by this ADR rather than
by code, unless X is a shape one of the two authored producers actually emits. A finding that shape X
is *silently dropped* remains a real defect — refusing is the contract, ignoring is not.

Section-boundary detection is not an accepted shape and stays: recognising a setext underline or a
thematic break as ending the header region prevents body prose being read as a field, which is a
safety property rather than input tolerance.

If a third producer ever appears, the grammar is extended here first and in the parser second.
