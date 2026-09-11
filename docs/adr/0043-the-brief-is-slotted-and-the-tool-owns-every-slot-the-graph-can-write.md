# The brief is slotted, and the tool owns every slot the graph can write

The answer a session relays becomes a **brief**: what the plain rendering carries, with composed
paragraphs around it — every fact of it bar one stated exception, under "What stays a contract". It
is assembled from a fixed list of slots, each owned by exactly one half — the tool, or the session
composing. The session may not write a tool-owned slot, reorder one, or leave one out; the tool
never writes a session-owned one.

The motivating example is the brief quoted in issue 80's body, emitted by the two skills this tool
retires and captured verbatim from a sibling repository. Every phrase attributed to it below is from
there.

The split is not facts against prose. It is **the graph and the ladder against the ticket body**:
every sentence derivable from the ticket set is the tool's, said as a sentence rather than a field
and fixture-tested, and the session's whole territory is what can only be written by reading a
free-text body.

The line falls there because most of what looked like judgment is arithmetic the ranking already
does. "The wave narrows nothing; the tie-break did the work" is `decision.rung` against the ladder's
last rung; compressing twenty-two also-rans into one clause is grouping `ranked` by the ladder's
keys *and* by the labels no rung reads, which is what leaves the runner-up worth naming on a tie.
Both are deterministic data checks, and a model asked to make them can get them wrong in a way no
fixture would catch.

## The worked example

Against a real pick from this repository, captured 2026-09-11 and reproduced verbatim. It is a
snapshot, not a claim about any current state: three of the tickets in it closed within hours of the
capture, so a run today prints something else and a reader should expect that rather than reconcile
it. What the example argues is a property of the numbers quoted, which is why they are quoted.
Repository coordinates are elided in the blocks, since the identifier guard's allowlist is not
widened for an example ([0006](./0006-provenance-prevents-leaks-the-guard-is-a-backstop.md)).

Today's rendering, seven lines:

```
gh:<owner>/<name>#39 — ADR-0013's absolute-root promise conflicts with its symlink rule on macOS
  <the issue URL>
  won on reference over gh:<owner>/<name>#50
  priority none, unblocks 0, blockers confirmed closed

19 tickets: closed not asked, 2 claimed, 5 filtered out (excluding wayfinder:*, needs-triage, spec), 12 candidates (6 unblocked, 0 unknown, 6 blocked)
claude '/implement gh:<owner>/<name>#39'
```

The brief the same pick produces:

```
Next: gh:<owner>/<name>#39 — ADR-0013's absolute-root promise conflicts with its symlink rule on macOS
  <the issue URL>

19 tickets: closed not asked, 2 claimed, 5 filtered out (excluding wayfinder:*, needs-triage, spec),
12 candidates (6 unblocked, 0 unknown, 6 blocked) · unblocks 0 · blockers confirmed closed

ADR-0013 promises a parametric absolute worktree root and, in the same decision, refuses a symlink
anywhere along it. On macOS /tmp, /var and /etc are symlinks into /private and $TMPDIR sits under
/var/folders, so every natural absolute root is refused, naming a path the caller never typed. The
default .worktrees escapes only because git hands back a realpath'd primary checkout — so the guard is
inert for the default and total for every absolute root under a system temp directory. The suite is
green only because the test helper realpaths every root it makes, a workaround rather than coverage.

Scope — a decision between two candidates, plus a status banner: ADR-0013's body is append-only, so
whichever wins needs a new ADR of its own. Retires nothing.

Constraints not carried by any edge
- ADR-0013 refuses symlinks because git registers a worktree under the resolved path, so a root
  reached through a link registers where `ensure` would not look for it (cited, from the body).

Nothing separated the six. None carries a priority and none blocks anything, so the ladder fell
through to the reference tie-break and the lowest number won.

Also on the frontier: #50 is the one to weigh against this, and not because of the ranking — it is
the only bug among the six and the only one carrying ready-for-agent, and the ladder reads neither.
The remaining four — #58, #70, #77, #79 — are leaves with the same three signals as the pick. Six
more candidates are blocked and were never ranked.

In flight, in this repository: #80 and #53 are assigned to you.

Ready to build: claude '/implement gh:<owner>/<name>#39'
```

Two things this example settles that a richer pick would have hidden.

**The best move in the motivating example is unavailable here.** That brief argued its pick by a
chain to a downstream goal. On this pick every ranked candidate has `unblocks 0`: there is no chain,
no goal, and nothing downstream. A shape that expects the chain argument invites a model to invent
one.

**The alternatives slot earns its place even on a tie.** The ladder reads priority, unblocks and
reference — [0003](./0003-ranking-ladder-fixed-in-code.md) — and nothing else. Here the runner-up
carries `bug` and `ready-for-agent` and the pick carries neither, and no rung looked. Naming the
labels the tie-break ignored is the most useful sentence in the whole brief, and it is arithmetic.

This contradicts [0011](./0011-what-each-ranking-rung-reads.md) — "tracing why a *losing* ticket was
not ranked on its label is a `--json` question" — and slot 7 answers it on the human surface
instead. What each rung *reads* is untouched; only where a reader goes to see a loser's labels
moves. On a tie those labels are the only thing distinguishing six candidates, so sending a person
to `--json` hides the one fact the brief exists to surface.

## The slots

Ten, in this order. "Present" means the tool can already produce the input today.

| # | Slot | Written by | Input it needs | Present |
| - | ---- | ---------- | -------------- | ------- |
| 1 | Headline | tool | `pick.ref`, `title`, `url` — or the reason there is none | yes |
| 2 | Standing | tool | `counts`; with a pick, also `unblocks` and the blocking phrase | yes |
| 3 | Substance | session | the pick's raw body | **no** |
| 4 | Scope | session | the same body | **no** |
| 5 | Constraints no edge carries | session | the same body, checked against the graph | **no** |
| 6 | Why this one | tool | `decision.rung`; a *path*, and its endpoint's open blockers | rung only |
| 7 | Alternatives | tool | `ranked` with labels; the unranked partition's count | yes |
| 8 | In flight | tool | the viewer's identity; the claimed tickets' references; every assignee | **no** |
| 9 | Contract lines | tool | `degraded: `, `deadlock: ` | yes |
| 10 | Action | tool | the session command | yes |

**Slot 1 has two forms and `Selection.pick` decides which.** With a pick it is the reference, the
title and the URL. With none it is `no candidate to recommend` and *why* — five reasons today: a
quiet day, a wholly blocked set, a deadlock, a read that failed, and a read that came back
incomplete. [0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md) makes the
last two one class and `skills/nextup/SKILL.md` splits them, because their remedies differ: a failed
read is retried, while an incomplete one held back tickets that were really there. Slot 1 follows
the skill.

Those five are the ones with a remedy of their own in 0038 and the skill; they are not the only way
`select` reaches a null pick. A set whose every open ticket is claimed, or filtered, or a mixture,
answers with no candidate and none of the five. Totality does not depend on enumerating them: the
counts partition every ticket by construction — `closed + claimed + filtered + candidates ===
tickets` — so there is always a fact to name, and the open class is what lets the headline name it.

Reasons overlap — a blocked set whose blockers form a cycle is two of them — so the requirement is
that the headline be **total**: one for one answer, not one per applicable reason and not whichever
the implementation tests first. Precedence or a combined sentence is the renderer's choice, and
either is safe because each reason is independently visible anyway, three on their own slot 9 line
and two off slot 2's counts. That is also the joining rule for the class, which is open rather than
an enum: a new reason may enter only if slot 2 or slot 9 already carries it, or it brings its own
line.

**Slot 1 is the one slot that is never omitted.** Every other slot disappears when its input is
absent; this one has no absent case, because "there is no pick" is itself the answer. A no-pick
brief is therefore slots 1 and 2, and at most slots 8 and 9 — those two keep obeying the omission
rule, so a quiet day with nothing in flight and no degrade prints two slots, not four. There is no
action line, and that needs no rule: the tool already suppresses it on its own (`renderStart`
returns the empty string for `nothing-to-start`).

Slot 2 has two forms as well, decided the same way: with a pick, the counts plus the pick's
`unblocks` and blocking phrase; with none, the counts alone, which is how it still prints on a
no-pick brief where the other two do not exist. Slots 1, 2 and 6 are the whole of it — the other
seven have one form each, either because their input does not depend on the pick (8, 9) or because
they omit themselves when it is absent (3, 4, 5, 7, 10).

**Slot 6 has two forms too, and the path decides which.** Where one runs from the pick to a
downstream ticket, the slot names that ticket and what is left of it — *clearing this leaves `#216`
waiting on one more* — which is what a rung cannot say. "What is left of it" is a second fact rather
than a by-product of the path: the endpoint's own open blockers, which `Selection` does not carry,
because the graph does not survive it and `unblocks` counts the other direction on ranked candidates
only. A path without it names a goal and cannot say what reaching it buys. Where none runs, it names
the rung, and
where the rung is the ladder's last it says the ladder separated nothing.

A pick can reach several downstream tickets, so the goal form needs one endpoint rather than any
reachable one. Choosing it is an algorithm and this ADR does not write one: the input does not exist
yet, nothing here can run it, and a walk set down in prose hides the decisions a signature would
force. What is fixed here is what the walk must satisfy, so whoever supplies it can be held to this:

- **Farthest, not nearest.** The endpoint carries the most work stacked behind the pick. The nearest
  reachable ticket is usually a formality, and a walk returning it is wrong however
  deterministically it got there. The implementation states the distance it measures; this fixes
  only which end wins.
- **Total.** One endpoint per selection whatever the graph's shape or the traversal's order, ties
  broken by `compareTicketRefs` — the ladder's last rung, and already how `fromLowestRef` makes the
  deadlock walk assertable.
- **Terminating on a cycle.** The blocking graph permits them
  ([0030](./0030-a-deadlock-is-named-beside-the-answer.md)), so the walk answers rather than
  diverging. Which policy reaches that is the implementation's to choose and to write down.
- **Consistent with the standing line.** Every dependent the path traverses is open, because
  `countUnblocks` skips the ones that are not ([0011](./0011-what-each-ranking-rung-reads.md)) and a
  goal reached through a closed ticket is not advanced by clearing the pick.

Three fixtures make those checkable rather than advisory: two endpoints at equal distance, a set
holding a cycle, and a path whose intermediate ticket has closed.

The reason comes before the alternatives, which inverts the motivating example's order. "Also on the
frontier" is not readable until you know whether the ranking decided anything: on a tie it is the
whole argument, and after a decisive rung it is an aside. Ordering it second lets one shape carry
both.

Three inputs are missing, and that is the whole of what issue 72 has to supply: **the pick's raw
body**, **enough to say what the viewer is holding**, and **a path to a downstream ticket carrying
that endpoint's remaining open blockers** — neither the count `unblocks` already is, nor the path on
its own. Every other slot reads something the selector
holds. Slot 7 in particular needs nothing new — `ranked` already carries each candidate's labels.

Slot 8 needs three things, not one, and all three are plumbing over rows already fetched rather than
a second read: who the viewer is; the claimed tickets' references, which `select` reduces to the
bare `counts.claimed` so none reaches `Answer`; and every assignee rather than the first, since
`readClaim` keeps only `assignees[0]` and a ticket the viewer shares is still in flight for them.

That last is a repurposing rather than an addition. `readClaim`'s comment says which assignee it
reports "is display, and every reading that decides anything asks only whether a claim exists" —
true of every reader it has. Slot 8 would be the first needing the claimant to decide something, so
the field gains a second meaning unless the read widens. Widen the read.

Slot 6's path is the one missing input another ticket may derive first, for its own reasons — a rung
ranking on distance to a named entry point needs the same walk over the same edges. **One derivation
serves both, and the second consumer reads it rather than repeating it.** That, rather than a metric
written down here, is what keeps the brief from arguing a chain the ranking disputes: two callers of
one function agree whatever the function decided, and two implementations of one graph fact do not,
however carefully each was specified.

Defining the walk here — the distance measured, whether paths are simple, how a cycle is collapsed —
is declined, recorded so it is not reopened. An algorithm in prose has no compiler and no fixture,
so every clause of it is unverified the moment it is written. The requirements above are what a
fixture can hold, and the walk belongs in the ticket with the input to run it against.

## What stays a contract

[0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md) chose the plain
rendering as the thing a session relays, because it is not a lossy summary of `--json`. That holds,
as two promises rather than one.

**No fact the plain rendering carries is dropped**, with one exception stated here rather than left
to be discovered: a priority absent from *every* candidate leaves the standing line, because it
distinguishes nothing, and returns the moment one candidate carries it. Everything else — the
counts, the signals, the runner-up, the deciding rung, the deadlock chains — reaches the reader.

**The lines a caller greps for are byte-identical.** `degraded: ` and `deadlock: ` stay at
line-start, never wrapped in prose, never summarised, never budgeted away.

Saying they are slot 9's and that slot 9 is the tool's does not make that true — ownership is an
assertion, and a session that types the finished brief can drop a `degraded: ` line and still
produce something plausible. 0038 made the prefixes a contract because a person greps for them; a
composed answer is exactly where that contract quietly dies. So ownership needs a mechanism, and
this is the requirement:

**A tool-owned slot reaches the reader without being retyped by the session.** Whatever composes
the brief, the session must not be the thing reproducing a contract line. Two shapes satisfy it and
the implementation picks: the tool assembles the brief from paragraphs the session supplies as
inputs, or the tool's own output passes through as a block the session may only write around. What
does not satisfy it is a session reading the rendering and writing the whole answer out again, which
is what `/nextup` does today and why this cannot ship as an instruction to compose more carefully.

Verify it the way the trust boundary demands rather than by inspection: a brief built from a
selection carrying a degrade and a deadlock contains those lines byte-for-byte, and still does when
the session's own slots are empty.

Everything else is re-expressed rather than reproduced, and the worked example above shows it: slot
2 folds the pick's signals into the counts line, and slot 6 says what the pick buys rather than
which rung fired, handing the runner-up to slot 7. So a caller matching on `won on ` breaks. Nothing
does — the prefixes are the contract and 0038 says so — but the difference between the two promises
is exactly this, and stating only the stronger one would have promised a rendering the brief does
not emit.

References are qualified once, on the headline, and bare thereafter **in the prose slots only**. A
run reads one repository's tickets — checkout identity is resolved once and a foreign ticket is
refused ([0040](./0040-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md))
— so repeating the coordinates a dozen times restates something already fixed for the whole answer.

Slots 9 and 10 are exempt, and the exemption is not a concession — each has a reason the prose slots
do not. Slot 9's lines are byte-identical by the promise above, and `deadlockLine` and both
reference-carrying degrade reasons qualify every reference through `formatTicketRef`; shortening
them would be the edit that promise forbids. Slot 10 is a command someone pastes, and a bare
reference in it resolves against whatever checkout they are standing in rather than the one that
produced the answer. Without the exemption an implementation has to break one rule or the other, and
the worked example above already prints both lines qualified.

## The length budget

Twenty-five content lines is the ceiling; blank lines between slots count nowhere here, and the
slots below sum to twenty-three. The floor on a run that picked something is today's six — the seven
0038 counts, less its blank — and a run that picked nothing floors lower still, at the two slots
that always print, rather than being padded up to meet it. The budget is per slot rather than whole,
because slots 3 to 5 are the only ones a model writes and an unbudgeted brief is one where they
absorb everything:

| Slot | Lines |
| ---- | ----- |
| Headline | 2 |
| Standing | 2 |
| Substance | 6 |
| Scope | 2 |
| Constraints no edge carries | 3 |
| Why this one | 2 |
| Alternatives | 4 |
| In flight | 1 |
| Action | 1 |

Contract lines are exempt. A warning is never cut to fit, and a set with four deadlock cycles prints
four.

**A slot with nothing to say is omitted, not padded — except slot 1.** That is what makes the floor
reachable: on a pick with an empty body, slots 3 to 5 are absent and the brief is the plain
rendering with slots 6 to 8 around it. The exception is what keeps the rule from deleting the answer
on a run that picked nothing, where every other slot is empty and the headline is the whole point.
There is no "no acceptance criteria found" line, because a line saying nothing was found costs the
same as one that found something and is worth less than the blank.

## Thin inputs, which is the common case

The worked example is the thin case, and the rules come from it.

**A tie is named as a tie.** Where the deciding rung is the ladder's last, the brief says the ladder
found nothing to separate the candidates. It does not report the tie-break as a win. This is a
comparison against `LADDER`'s tail rather than a literal, the same way `decidingRung` already avoids
drifting from the ladder.

**Substance comes from the body or not at all.** Restating the title in longer words is the failure
this shape exists to prevent — the title is already on line 1. A model that has read no body writes
no slot 3.

**A claim found in the body is reported as a claim.** A body saying "this is blocked on the auth
work" is not blocking state: no edge carries it, the tracker never reported it, and folding it in
would be the collapse `CONTEXT.md` forbids under **Unknown**. It goes in slot 5, attributed and
citable, which is what that slot is for.

**A body with no criteria yields no slot 4.** Scope is a count *and a shape* — "7 items plus 3 guard
tests", or the worked example's "a decision between two candidates, plus a status banner" — and a
body carrying neither has no scope to state. Counting the paragraphs, or calling the whole body the
scope, produces a line that is true of every ticket and therefore says nothing.

**With one candidate, slot 6 is omitted.** "It was the only one" is already slot 2's job.

## Consequences

The shipped answer is no longer deterministic end to end, and the scenario fixtures assume it is.
They keep working — they assert `Selection`, and five also pin `renderSelection` byte-for-byte — but
only because the brief is composed *beside* the plain rendering rather than by editing it. That is a
constraint on the implementation, not an observation: a slot 2 that folds the signals by changing
`renderSelection` breaks five golden files and moves the surface 0038 pins. What the fixtures no
longer cover is the whole of what a reader sees. Every tool-owned slot should stay exact under
fixture, slot 8 included: what it lacks is an identity, not a judgement. Controlling the three
composed slots is out of scope here.

Nothing here ships yet. `skills/nextup/SKILL.md` still describes relaying the plain rendering, which
is correct until the three missing inputs exist: a skill told to compose slot 3 today would compose
it from the title. [0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md)'s
relay instruction stands until then.

Slot 8 says "in this repository", so an empty slot is not read as holding nothing anywhere. The
wider query the motivating example implied — assigned to me across every repository — is refused for
the reason
[0040](./0040-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md) refuses a
foreign ticket: the tool's world is the checkout it stands in, and it would be reporting on ticket
sets it has not read. The cost is real, since in-flight work elsewhere is exactly where the line
would have mattered most. Widening it is a decision of its own, with a scope binding and a limit.

Two sentences now live in TypeScript that a model would otherwise have written: the tie-break
wording, and the compression of the alternatives. That grows `selection-output.ts`, which already
carries more comment defending this kind of wording than most files here carry code. It is the trade
the repository already took for `degraded: ` and `blockingPhrase` — a sentence a fixture can assert
cannot drift — against a model deciding whether six tied candidates were separated.
