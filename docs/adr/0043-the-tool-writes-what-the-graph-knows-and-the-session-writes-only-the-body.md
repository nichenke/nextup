# The tool writes what the graph knows; the session writes only the body

The answer a session puts in front of a person becomes a **brief**: the plain rendering's facts,
with composed paragraphs around them. This decides who writes which part, and what the composition
may not cost. It does not specify the brief — the list of parts, the inputs each needs and the
budget are specification, and they live on issue 72, which has a compiler to settle them against.

## The split is the graph against the body, not facts against prose

Issue 80 framed the choice as "the tool emits facts the ranking already knows plus the raw body, and
the skill composes". That framing is wrong in a way worth recording, because it gives the model far
more than it needs.

Most of what reads as judgment in the motivating example — the brief quoted in issue 80's body,
emitted by the two skills this tool retires — is arithmetic the ranking already does. "The wave
narrows nothing; the tie-break did the work" is the deciding rung compared against the ladder's
last. Compressing twenty-two also-rans into one clause is grouping the ranked set by the ladder's
keys and by the labels no rung reads. Both are deterministic data checks, and a model asked to make
them can get them wrong in a way no fixture would catch.

So the line falls elsewhere: **every sentence derivable from the ticket set is the tool's**, said as
a sentence rather than as a field and asserted by fixture. The session's whole territory is what
cannot be written without reading a free-text body — what the ticket makes true, its acceptance
criteria, and the constraints its body names that no edge carries.

The cost is that the shipped answer is no longer deterministic end to end, which the scenario
fixtures assume. They keep working, because they assert the selection and five pin the plain
rendering byte-for-byte. That holds only while the brief is composed *beside* the plain rendering
rather than by editing it, which is a constraint on the implementation rather than an observation
about it.

## Ownership is not a mechanism

The rejected position, and the one this ADR was first written with, is that naming a part "the
tool's" makes it safe. It does not. If a session composes the finished text it can drop a `degraded:
` line and produce something entirely plausible, and nothing fails.

That matters because [0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md)
made `degraded: ` and `deadlock: ` a contract precisely so a person can grep for them. A composed
answer is exactly where such a contract dies quietly. So the decision is not only who owns each part
but **that a tool-owned part reaches the reader without being retyped by the session** — whatever
assembles the brief, the session must not be the thing reproducing a contract line.

This rules out the shape `/nextup` has today, which reads the rendering and writes the whole answer
out again. It cannot be fixed by instructing a session to compose more carefully.

## What the contract survives as

[0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md) chose the plain
rendering as what a session relays, because it is not a lossy summary of `--json`. That holds, as
two promises rather than one:

- **No fact the plain rendering carries is dropped** — with one exception, stated here rather than
  left to be found: a priority absent from *every* candidate leaves the standing line, because it
  distinguishes nothing, and returns the moment one candidate carries it.
- **The lines a caller greps for are byte-identical.** `degraded: ` and `deadlock: ` stay at
  line-start, never wrapped in prose, never summarised, never dropped to save room.

Everything else is re-expressed rather than reproduced, and a caller matching on `won on ` breaks.
Nothing does — the prefixes were always the contract, and 0038 says so — but the two promises are
not the same promise, and stating only the stronger one would describe a rendering the brief does
not emit.

## Length is budgeted per part, and thin inputs are answered honestly

Twenty-five content lines is the ceiling; today's plain rendering is the floor. The budget is
allocated per part rather than to the whole, because the parts a model writes are the only ones that
can run long, and an unbudgeted brief is one where they absorb everything. The numbers are on issue
72.

Four rules make the thin case honest, and they are decisions rather than mechanism:

- **A part with nothing to say is omitted, not padded.** A line reporting that nothing was found
  costs as much as one that found something and is worth less than the blank.
- **A tie is named as a tie.** Where the deciding rung is the ladder's last, the brief says the
  ladder separated nothing rather than dressing the tie-break as a win.
- **Substance comes from the body or not at all.** Restating the title in longer words is the
  failure this shape exists to prevent; the title is already on the first line.
- **A claim found in a body is reported as a claim**, attributed and citable. A body saying "this is
  blocked on the auth work" is not blocking state — no edge carries it, the tracker never reported
  it, and folding it in is the collapse `CONTEXT.md` forbids under **Unknown**.

## What the reader already holds belongs here

"In flight: this is assigned to you" is not a property of the pick at all, and issue 80 asks whether
it belongs to this tool. It does — it is the one line that changes what a person does next — but two
existing decisions bound what it may claim, and it is worth stating them here rather than leaving
issue 72 to discover them.

[0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md) settled that no identity is compared,
and [0037](./0037-naming-a-ticket-skips-the-ranking-and-nothing-else.md) reads that as ruling out
the lookup that would say whether a claim is yours. **This narrows that ruling rather than reversing
it, and the distinction is the reason 0018 gives.** Its argument is that comparing identities cannot
*arbitrate* — every agent here authenticates as the same identity, so finding that identity on a
ticket is equally consistent with this session's write and a sibling's a minute earlier. That
defeats arbitration. It does not defeat reporting, because the line makes no claim about which
session wrote the assignee; it says only that the ticket is held by the identity the reader
authenticates as.

Two consequences follow that the line has to be honest about. It cannot distinguish the reader from
a sibling agent on the same credential, so its wording must not promise a person. And it is not
free: the assignees are already on every row, so no second pass over the ticket set is needed, but
the reader's own identity is a call the tool does not make today.

Scoped to the ticket set already read, and it says so. The wider query the motivating example
implied — assigned to me across every repository — is refused for the reason
[0040](./0040-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md) refuses a
foreign ticket: the tool's world is the checkout it stands in, and it would otherwise report on
ticket sets it has not read. The cost is real, since in-flight work elsewhere is where the line
would have mattered most, and widening it is a decision of its own with a scope binding attached.

## Consequences

**This contradicts [0011](./0011-what-each-ranking-rung-reads.md)**, which says the human rendering
shows only the pick's labels, so tracing why a *losing* ticket was not ranked on its label is a
`--json` question. The brief answers it on the human surface. What each rung *reads* is untouched;
only where a reader goes to see a loser's labels moves. The argument is the tie: when the ladder
separates nothing, the labels it never read are the only thing distinguishing the candidates, and
sending a person to `--json` hides the one fact the brief exists to surface.

**Nothing ships yet.** `skills/nextup/SKILL.md` still relays the plain rendering, which stays
correct until issue 72 supplies what the composed parts need. A skill told to compose from the body
today would compose from the title.

**Deciding the shape first was the point.** Issue 80 exists because issue 72 would otherwise guess
which fields might help. It now has a list of inputs derived from an answer somebody wants to read,
and the constraints review put on that answer are recorded there rather than here — they are settled
by a signature or a test, which is a cheaper place to settle them than prose.
