# A recording's hosts become a dot-less placeholder, not an allowlisted synthetic host

This amends the last section of
[0019](./0019-every-recording-is-captured-from-a-test-tree.md), which says the synthetic hosts "are added
to the identifier allowlist deliberately". They are not added to it at all. Everything else 0019 says
about identifiers stands: one host per tracker, replaced at capture time, never a pattern that accepts a
family.

Before it is stored, every host in a captured exchange is replaced with a dot-less stand-in —
`github-test-tree` for the GitHub tree. `redactRecordingIdentifiers` in `src/recording-identifiers.ts`
does it, and keeps the path, so a reader can still tell one issue's URL from another's.

## Why not the allowlist

The allowlist compares whole tokens, exactly, for the reasons
[0006](./0006-provenance-prevents-leaks-the-guard-is-a-backstop.md) gives — every attempt at accepting
part of a token needed a URL grammar, and each grammar had a bypass. What makes it the wrong place for a
recording is what a *token* turns out to be.

It is not a URL. The guard's scheme shape runs to the next whitespace, and `gh --json` prints its whole
document on one line, so the token is everything from the first scheme to the end of that line. Measured
on a two-URL line, `grep` returns one match containing both URLs and the JSON punctuation between them.

Allowlisting a recording therefore means three things, and the third is the disqualifying one:

- The `ALLOWED` entry is a verbatim copy of the recording's body, not a name for a host.
- It churns on any byte after the first scheme on that line — a new issue, a renumber, an edited title, a
  state flip — so every capture rewrites the entry.
- It accepts every identifier later on that line, sight unseen. That is precisely the failure 0006
  documents and refuses, where "a copied URL carrying `?redirect=` plus a private host was accepted before
  the inner host was ever looked at" — reintroduced deliberately, and at the scale of a whole recording.

No count is given here on purpose. How many tokens a recording produces depends on a storage format that
does not exist yet: compact single-line output gives roughly one token per captured command, pretty-printed
storage roughly one per URL-bearing line, and an escaped-stdout fixture tokenizes differently again because
the guard turns `\n` escapes into real newlines before matching. The argument above holds for all three.

A dot-less host needs no entry at all, because it matches none of the guard's three host shapes. Each
requires something the placeholder does not have: a scheme, an `@` before a dotted host, or a dotted host
before a `/` or a `:`. The placeholder is not an exception the guard tolerates; it is a token the guard is
not looking for.

## What this does not claim

Redaction has one rule per shape the guard matches: a scheme with its authority, an `@` before a dotted
host, and a dotted host before a `/` or a `:` with no scheme and no user. The third exists because the
first two left it out, and a shape redaction misses does not stay missed — it fails the build on the next
capture, and the tempting repair is the allowlist line this ADR exists to avoid. So the rules track the
guard's shapes deliberately, and widening the guard means widening these.

It is still not a proof of absence, for the same reason the guard's own header gives about its
normalization: an encoding neither recognises passes through.

The guard has a fourth shape that redaction cannot reach at all: a slug reference like `owner/repo` and a
`#` before digits, which carries no host, so rewriting hosts does nothing to it. GitHub emits that form in
cross-references and in dependency prose. Nothing here closes it, and the tree's own issue text avoids
cross-references for that reason. If one does reach a recording, the choice is between teaching redaction
the tree's own slug and refusing to store that content — a decision for whoever builds capture, with the
guard failing the build until it is made.

So the guard stays the backstop, which is the arrangement 0006's title already names. A recording that
trips it on a host shape is a signal to extend redaction rather than to add an allowlist line — the line
would record that this one identifier is acceptable, when the fact to record is that a shape got past
redaction and will get past it again on the next capture. On the slug shape, where extending redaction is
not available in the same way, the remedy is to change what the tree's issues say, because an allowlist
entry copied out of a recording carries the same blanket acceptance described above.

## Consequences

Storing a recording costs nothing at the guard. This is the difference between a corpus that grows from
reality, which is what 0019 is for, and one whose growth has a per-issue tax attached.

The placeholder is dot-less rather than merely synthetic, so `example.com` and friends are the wrong
choice here even though they read more naturally as hosts — they are dotted, so each URL built on one
would still need its line.

Redaction has to run before a recording is written, not after. There is no step that checks a stored
recording and fixes it, and the guard's report arrives once the file is already tracked.
