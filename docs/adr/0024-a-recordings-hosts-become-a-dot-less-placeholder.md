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
part of a token needed a URL grammar, and each grammar had a bypass. That property is what makes the
allowlist the wrong place for a recording. A recording of the test tree holds a distinct URL for every
issue in it, several per issue once the embedded repository object is counted, and each distinct one is
its own token. Seventeen issues would cost dozens of `ALLOWED` lines, and every capture that added an
issue would add more — which turns the deliberate, individually reviewable line `CLAUDE.md` asks for into
a bulk edit nobody reads.

A dot-less host needs no line, because it matches none of the guard's four shapes. Each of them requires
something the placeholder does not have: a scheme, an `@` before a dotted host, a dotted host before a
`/` or a `:`, or a `#` before digits. The placeholder is not an exception the guard tolerates; it is a
token the guard is not looking for.

## What this does not claim

Redaction closes the shapes a tracker CLI is known to emit — a scheme with its authority, and the
scp-form remote and email address that carry no scheme. It is not a proof of absence, for the same reason
the guard's own header gives about its normalization: an encoding it does not recognise passes through.

So the guard stays the backstop, which is the arrangement 0006's title already names. A recording that
trips it is a signal to extend redaction, never to add an allowlist line — an allowlist line would record
that this one identifier is acceptable, when the fact to record is that a shape got past the redaction and
will get past it again on the next capture.

## Consequences

Storing a recording costs nothing at the guard. This is the difference between a corpus that grows from
reality, which is what 0019 is for, and one whose growth has a per-issue tax attached.

The placeholder is dot-less rather than merely synthetic, so `example.com` and friends are the wrong
choice here even though they read more naturally as hosts — they are dotted, so each URL built on one
would still need its line.

Redaction has to run before a recording is written, not after. There is no step that checks a stored
recording and fixes it, and the guard's report arrives once the file is already tracked.
