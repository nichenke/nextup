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

The rules also have to copy the guard's *normalization*, not only its shapes. A URL whose slashes are
backslash-escaped carries no literal `://`, so every rule missed it while the guard — which unescapes
first — flagged the host: a real host stored verbatim in a recording. Redaction now unescapes `\/` before
matching, and deliberately does not copy the guard's other normalization, since turning `\n` into a real
newline would break the JSON a recording is made of.

That class of bug is why the parity test runs the **real** guard over the redacted corpus, in a throwaway
git repository, rather than a copy of its pattern in TypeScript. The copy agreed with the code it was
transcribed from, and neither agreed with the guard. A transcription cannot catch a divergence in the thing
it was transcribed from; only the original can.

A redacted URL is no longer a URL. The scheme is consumed along with the authority, so what remains is the
placeholder followed by the path, and `new URL()` on it throws. That is intended: leaving the scheme in
place would leave a token the guard matches whatever the host is, because its scheme shape needs no dot at
all. Whoever reads a recording's `url` field must treat it as an opaque string.

**Considered and not taken:** replacing the tree's known host strings literally instead of matching host
*shapes*, which would retire the grammar this reintroduces — the same argument ADR-0006 accepted when it
chose whole-token comparison over URL parsing. It is a real objection. It is not taken because a recording
carries hosts beyond the tree's own, so a literal list has to be complete to be safe, and being wrong is
silent in exactly the way a shape rule is not. What makes the shape rules defensible is that the guard, not
a transcription of it, is the oracle: a divergence fails a test rather than shipping.

The guard has a fourth shape that redaction cannot reach at all: a slug reference like `owner/repo` and a
`#` before digits, which carries no host, so rewriting hosts does nothing to it.

This is not hypothetical, and it decides something about capture. Redaction was run over roughly 30 KB of
real output from the live tree and the guard's pattern run over the result; exactly two tokens survived,
both of the slug shape, and both from the `blocked-by:` line of plain `gh issue view`. The same information
requested as `gh issue list --json blockedBy` comes back as objects of id, number, state, title and URL,
with no slug form anywhere and every URL carrying a scheme that redaction rewrites.

So the rule for capture is to record `--json` surfaces, on which this shape does not occur, rather than the
human-readable views, where it occurs on the first capture. That is a stronger reason to prefer `--json`
than mere parseability, and it is why the tree's own issue text also avoids cross-references. If a
human-readable surface is ever wanted for its own sake, the shape has to be closed first — by teaching
redaction the tree's slug, since the guard will fail the build until something does.

So the guard stays the backstop, which is the arrangement 0006's title already names. A recording that
trips it on a host shape is a signal to extend redaction rather than to add an allowlist line — the line
would record that this one identifier is acceptable, when the fact to record is that a shape got past
redaction and will get past it again on the next capture. On the slug shape, where extending redaction is
not available in the same way, the remedy is to change what the tree's issues say, because an allowlist
entry copied out of a recording carries the same blanket acceptance described above.

## Consequences

Storing a `--json` recording costs nothing at the guard — measured, not assumed, and the qualifier is
load-bearing: a plain `gh issue view` costs a build failure. This is the difference between a corpus that
grows from
reality, which is what 0019 is for, and one whose growth has a per-issue tax attached.

The placeholder is dot-less rather than merely synthetic, so `example.com` and friends are the wrong
choice here even though they read more naturally as hosts — they are dotted, so each URL built on one
would still need its line.

Redaction has to run before a recording is written, not after. There is no step that checks a stored
recording and fixes it, and the guard's report arrives once the file is already tracked.
