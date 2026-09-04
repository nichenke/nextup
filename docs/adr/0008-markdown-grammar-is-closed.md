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
- Field lines in the header region, in a paragraph rather than a list, quote or code block: `Type:`,
  `Status:`, `Blocked by:`. Inline emphasis does not matter, because ADR-0009 reads a line's *rendered*
  text — `**Status:** x`, `_Status_: x` and `Status: x` are one line by the time the grammar sees them.
  That is narrower than it sounds: what a field may not be is a list item, a quote, a table cell or
  code, and those are block positions the lexer decides.
- `Blocked by:` as bare comma-separated ticket numbers, or `None` with optional dash commentary.
- Anything else in the header region is prose, which is how `to-tickets` writes `**What to build:**`.
- Fenced code blocks are skipped, so a snippet may quote any of the above.

**ADR-0010 supersedes what this section originally said about refusal.** It listed the out-of-grammar
shapes that were refused loudly — a bulleted or blockquoted field, a table row, a `## Blocked by`
heading, a renamed `Blockers:` — and the asymmetry that a stray `Status:` was ignored while a stray
`Blocked by:` was refused. None of that survives: out-of-grammar content is body text and is not
inspected at all. Deciding which of them to refuse required guessing what an author meant, which is the
one thing with no specification behind it, and six heuristics later it was still failing in both
directions. ADR-0009 moves the same decision about *where* a code block or a section begins out of this
file too — the boundary is whatever a CommonMark lexer says it is.

Validation of the grammar itself is unaffected and still fails loudly: an unrecognised `Status:` value,
a present-but-empty `Blocked by:`, a non-numeric blocker token, a duplicated field, a missing title.

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
