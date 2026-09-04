# Block structure comes from a CommonMark lexer, not from patterns here

`marked` is a dependency. The markdown adapter asks it for the block structure of a ticket file and
reads fields out of the resulting tokens, instead of deciding with regexes which lines are code, which
are headings, and where the header region ends.

## Why

Ticket 05 took seven review rounds. After ADR-0008 closed the accepted field grammar, that half went
silent — no finding since has touched it. Every finding after it was a place where a hand-written
pattern diverged from CommonMark's block grammar:

1. A fence closer must use the character the opener used
2. A fence closer may carry only trailing whitespace, so ` ```ts ` is content
3. A setext underline is one *or more* `=` or `-`, not three
4. A thematic break may contain spaces — `* * *`
5. An ATX heading needs no trailing content — `##` alone is a heading
6. An indented block is code
7. Ordered lists use `.` **and** `)`
8. Task-list markers exist — `- [ ]`
9. Markers nest — `> - `

Nine rules, each learned from a reviewer rather than from the spec, and each divergence was a way to
read a quoted or fenced field as a live one — which closes an open blocker and reports its dependent
as confidently `unblocked`, the one state `CONTEXT.md` forbids inferring. Three of the fixes introduced
fresh defects, twice reaching that same collapse from the opposite direction by refusing ordinary
prose. 27 lines of a 616-line file existed only to reimplement those rules, badly.

The pattern is not that reviewers were nitpicking. It is that this file contained a CommonMark block
parser that nobody had decided to write, so nothing bounded its remaining error. A parser written by
enumeration has no finishing condition, because the thing being enumerated is a specification.

## What this buys

Every one of the nine becomes someone else's problem, along with the ones not yet hit. A `code` token
is never a field because the lexer says it is code. A spaced break, a one-dash underline and a bare
`##` all end the header region because the lexer calls them a break and a heading. A task-list box, a
parenthesised ordered-list delimiter and a nested blockquote arrive with their markers already stripped,
recursively, so no marker set has to be maintained here at all.

What is left is the one judgment markdown cannot make: whether a line naming a blocker is a field or a
sentence. That stays local, in `declaresBlockers`, and it is now the only place a pattern decides
anything about a line's meaning.

## Cost

`marked` is this repo's first runtime dependency, on a public repo. It was chosen over
`mdast-util-from-markdown` and `commonmark` on supply-chain grounds: it installs as a single package
with no transitive dependencies, and it exposes a block lexer that returns exactly the token types this
needs. The registry pin in `bunfig.toml`, asserted in CI, still governs where it comes from.

A dependency is a real cost and this ADR does not pretend otherwise. It is smaller than the cost it
replaces: the alternative was continuing to discover CommonMark one review round at a time, in a code
path whose failure mode is handing out work that is actually blocked.

## Consequences

A markdown shape the adapter reads wrongly is now either a `marked` bug or a mistake in the small
amount of judgment left here, and those are different enough to tell apart. Neither is another rule to
enumerate.

Two behaviours changed, both toward what a renderer shows the author:

- A field inside **any** code block — fenced, indented, or in an unterminated fence — is an example and
  is skipped rather than refused. ADR-0008 said an indented `Blocked by:` was refused; it is now
  treated as code, because markdown says it is code and that is what the author sees. The residue is
  that a blocker accidentally indented four spaces is invisible. Accepted knowingly, and stated here
  rather than discovered later.
- A second level-one heading ends the header region instead of being refused as a duplicate title.
  Depth cannot tell the two apart, because a setext `===` underline also produces a level-one heading,
  and refusing a second H1 refused an ordinary underlined section.

ADR-0008 still stands and this does not reopen it. The accepted grammar is unchanged, and the
asymmetry it names is unchanged: a stray `Blocked by:` is refused because dropping one reads as a
confident `unblocked`, while a stray `Status:` is ignored because dropping one errs open and unclaimed.
What changed is only who decides where "stray" begins.
