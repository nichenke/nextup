# The markdown reader infers nothing from out-of-grammar content

The adapter reads the accepted grammar and stops. A line that is not a field is body text, and no
attempt is made to work out whether the author meant it as a blocker declaration. There is no refusal
for out-of-grammar content, because there is nothing left doing the guessing.

## Why

ADR-0008 closed the accepted grammar and that half has been quiet ever since. ADR-0009 moved block
structure, and then inline structure, to a CommonMark lexer, which ended a run of nine divergences from
the spec. What survived both was a detector trying to answer a different question: *did the author
intend a blocker here, in a shape I do not read?*

That question has no specification to defer to. Over seven review rounds the detector accumulated an
enumerated synonym list, a bare-numbers clause, a lead-in-colon clause, a sentence-end clause, a
hand-rolled table-cell strip and a one-block lookahead — six heuristics. A final review round found
holes in every one of them, in both directions at once:

- silently dropped: `Requires: 1`, `Waiting on: 1`, `| id | Blocked by: 1 |`,
  `<!-- Blocked by: 1 -->`, and `## Blocked by` above a list item carrying any prose
- falsely refused, taking a whole effort down: a paragraph reading only `Blockers`

Both failure modes present as the same thing to a user — "no work available" — which is the outcome the
detector existed to prevent. Every round of tightening it produced a new instance of one or the other,
because guessing intent is not a thing that converges.

## What markdown is actually for

The spec picks markdown for v1 to get "zero credentials and zero API archaeology, while exercising
every piece of the design." It is the fixture substrate that lets the spine — reference parsing, the
propagation module, the ranking ladder, the launcher, CI — be built and tested without a token. The
input population is one existing pack of `.scratch` tickets plus whatever this project writes itself.

The trackers that matter carry blocking as structured data: GitHub issue dependencies, GitLab links,
Jira issue links. None of them expresses a blocker as prose that has to be recognised. So effort spent
inferring intent from markdown text buys nothing for the three adapters still to come, and the risk it
was buying down is a risk only markdown has.

## Consequences

A blocker written outside the grammar is not read, and the ticket reads unblocked. That is a real
residue and it is accepted knowingly. What makes it acceptable is the input population: we write these
files, there is one existing pack, and the grammar is short enough to hold in your head — an H1 title,
then `Type:`, `Status:` and `Blocked by:` lines in the paragraphs under it.

Validation of the grammar itself stays, because that is checking a rule rather than guessing an
intention: an unrecognised `Status:` value, a present-but-empty `Blocked by:`, a non-numeric blocker
token, a duplicated field, a missing title, a title numbered differently from its filename, and any
filesystem failure all still fail loudly and name the file.

This supersedes ADR-0008's refusal list. Where that ADR says an out-of-grammar declaration "is refused,
loudly, naming the file", it is now simply not read. The asymmetry that ADR described — refuse a stray
`Blocked by:`, ignore a stray `Status:` — is gone with it, since neither is now inspected.

The check that would catch an authoring mistake belongs outside the reader, in the live check of
nichenke/nextup issue 26: a tool that compares a generated effort against the tracker it came from will
notice a blocker that failed to survive the round trip, and it can do that without the reader having to
guess anything at read time.
