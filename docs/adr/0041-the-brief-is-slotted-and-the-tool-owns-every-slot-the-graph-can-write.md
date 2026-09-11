# The brief is slotted, and the tool owns every slot the graph can write

The answer a session relays becomes a **brief**: everything the plain rendering carries, with
composed paragraphs around it. It is assembled from a fixed list of slots, each owned by exactly one
half — the tool, or the session composing. The session may not write a tool-owned slot, reorder one,
or leave one out; the tool never writes a session-owned one.

The motivating example is the brief quoted in issue 80's body, emitted by the two skills this tool
retires and captured verbatim from a sibling repository. Every phrase attributed to it below is from
there.

The split is not facts against prose, which is where this started. It is **the graph and the ladder
against the ticket body.** Every sentence derivable from the ticket set is the tool's, said as a
sentence rather than as a field, deterministic and fixture-tested. The session's whole territory is
the paragraphs that can only be written by reading a free-text body.

That line falls where it does because most of what looked like judgment is arithmetic the ranking
already does. "The wave narrows nothing; the tie-break did the work" is `decision.rung` compared
against the ladder's last rung. Compressing twenty-two also-rans into one clause is grouping
`ranked` by the ladder's own keys. Both are deterministic data checks, and a model asked to make
them can get them wrong in a way no fixture would catch.

## The worked example

Against a real pick, taken from this repository on 2026-09-11. The tracker has moved on since — the
tickets below have been claimed and closed in the ordinary way — so this is one run's snapshot rather
than what a run today prints. Everything the example argues from is a property of that snapshot, and
the date is what lets a later reader tell drift from error. The caveat deliberately names no ticket's
current state, because that is the half of a dated example that rots twice. Repository
coordinates are elided in the blocks; the identifier guard's allowlist is not widened for an example
([0006](./0006-provenance-prevents-leaks-the-guard-is-a-backstop.md)).

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
default .worktrees escapes only because git hands back a realpath'd primary checkout — so the guard
is inert for the default and total for every absolute root under a system temp directory. The suite
is green because the test helper
realpaths every temporary root it makes, which is a workaround rather than coverage.

Scope — a decision between two candidates, plus a status banner: ADR-0013's body is append-only, so
whichever wins needs a new ADR of its own.

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

So slot 6 has two forms and the input decides which, not the writer. Where a path runs from the pick
to a downstream ticket, the slot names that ticket and what is left of it — *clearing this leaves
`#216` waiting on one more* — which is what the rung cannot say. Where no path runs, the slot names
the rung, and where the rung is the ladder's last it says the ladder separated nothing. Both forms
are arithmetic over the same edges; the goal form is preferred and the rung form is the fallback,
which is why slot 6's missing input is a path and not a judgement.

**The alternatives slot earns its place even on a tie.** The ladder reads priority, unblocks and
reference — [0003](./0003-ranking-ladder-fixed-in-code.md) — and nothing else. Here the runner-up
carries `bug` and `ready-for-agent` and the pick carries neither, and no rung looked. Naming the
labels the tie-break ignored is the most useful sentence in the whole brief, and it is arithmetic.

This contradicts [0011](./0011-what-each-ranking-rung-reads.md), which says the human rendering
shows only the pick's labels, "so tracing why a *losing* ticket was not ranked on its label is a
`--json` question". Slot 7 answers it on the human surface instead. 0011's reasoning about what each
rung *reads* is untouched and still binds; what changes is only where a reader goes to see a loser's
labels, and the worked example is the argument — on a tie the labels the ladder ignored are the only
thing left that distinguishes six candidates, and sending a person to `--json` for them hides the one
fact the brief exists to surface.

## The slots

Ten, in this order. "Present" means the tool can already produce the input today.

| # | Slot | Written by | Input it needs | Present |
| - | ---- | ---------- | -------------- | ------- |
| 1 | Headline | tool | `pick.ref`, `title`, `url` — or the reason there is none | yes |
| 2 | Standing | tool | `counts`, `unblocks`, blocking phrase | yes |
| 3 | Substance | session | the pick's raw body | **no** |
| 4 | Scope | session | the same body | **no** |
| 5 | Constraints no edge carries | session | the same body, checked against the graph | **no** |
| 6 | Why this one | tool | `decision.rung`; a *path* to a downstream ticket | rung only |
| 7 | Alternatives | tool | `ranked` with labels; the unranked partition's count | yes |
| 8 | In flight | tool | the viewer's identity; the claimed tickets' references; every assignee | **no** |
| 9 | Contract lines | tool | `degraded: `, `deadlock: ` | yes |
| 10 | Action | tool | the session command | yes |

Slot 1 has two forms, the way slot 6 does, and `Selection.pick` decides which. With a pick it is the
reference, the title and the URL. With none it is what the rendering already says — `no candidate to
recommend` — and *why*. Today that is five reasons, not four: a quiet day, a wholly blocked set, a
deadlock, a read that failed, and a read that came back incomplete. The last two are one class in
[0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md) and two in
`skills/nextup/SKILL.md`, which splits them because they want different things said — a failed read
is retried, while an incomplete one held tickets back that were really there, and reporting it as a
quiet day presents withheld work as an empty queue. Slot 1 follows the skill and keeps them apart.

The reason is an open class rather than an enum fixed here: a scope that resolves to nothing is a
further member, and the slot takes it without a shape change.

**Slot 1 is the one slot that is never omitted.** Every other slot disappears when its input is
absent; this one has no absent case, because "there is no pick" is itself the answer. A no-pick brief
is therefore slots 1 and 2, and at most slots 8 and 9 — those two keep obeying the omission rule, so
a quiet day with nothing in flight and no degrade prints two slots, not four. There is no action
line, and that needs no rule: the tool already suppresses it on its own (`renderStart` returns the
empty string for `nothing-to-start`).

The reason comes before the alternatives, which inverts the motivating example's order. "Also on the
frontier" is not readable until you know whether the ranking decided anything: on a tie it is the
whole argument, and after a decisive rung it is an aside. Ordering it second lets one shape carry
both.

Three inputs are missing, and that is the whole of what issue 72 has to supply: **the pick's raw
body**, **enough to say what the viewer is holding**, and **a path from the pick to a downstream
ticket**
rather than the count `unblocks` already is. Every other slot reads something the selector holds.
Slot 7 in particular needs nothing new — `ranked` already carries each candidate's labels.

Slot 8 costs no extra ticket read, but it needs more than an identity, and the earlier draft of this
ADR said otherwise. Three things are missing and all three are plumbing over rows already fetched:
who the viewer is; the claimed tickets' references, which `select` reduces to the bare number
`counts.claimed` so that not one of them reaches `Answer`; and every assignee rather than the first,
because `readClaim` keeps only `assignees[0]` and a ticket the viewer shares is still in flight for
them.

That last one is a repurposing rather than an addition, and worth naming as such. `readClaim`'s own
comment says which assignee it reports "is display, and every reading that decides anything asks only
whether a claim exists" — true of every reader it has today. Slot 8 is the first that needs the
claimant's identity to decide something, so the field acquires a second meaning unless the read
widens. Widen the read.

Slot 6's path is the one missing input another ticket may derive first, for its own reasons — a rung
ranking on distance to a named entry point needs the same walk over the same edges. Whichever lands
first owns the derivation and the other reads it. Two implementations of one graph fact is how the
brief comes to argue a chain the ranking does not agree with.

## What stays a contract

[0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md) chose the plain
rendering as the thing a session relays, because it is not a lossy summary of `--json`. That holds,
as two promises rather than one.

**No fact the plain rendering carries is dropped**, with one exception stated here rather than left
to be discovered: a priority absent from *every* candidate leaves the standing line, because it
distinguishes nothing, and returns the moment one candidate carries it. Everything else — the
counts, the signals, the runner-up, the deciding rung, the deadlock chains — reaches the reader.

**The lines a caller greps for are byte-identical.** `degraded: ` and `deadlock: ` stay at
line-start, never wrapped in prose, never summarised, never budgeted away. A composing session that
cannot reach them still emits them, because they are slot 9 and slot 9 is the tool's.

Everything else is re-expressed rather than reproduced, and the worked example above shows it: slot
2 folds the pick's signals into the counts line, and slot 6 says what the pick buys rather than
which rung fired, handing the runner-up to slot 7. So a caller matching on `won on ` breaks. Nothing
does — the prefixes are the contract and 0038 says so — but the difference between the two promises
is exactly this, and stating only the stronger one would have promised a rendering the brief does
not emit.

References are qualified once, on the headline, and bare thereafter **in the prose slots only**. A
run reads one repository's tickets — checkout identity is resolved once and a foreign ticket is
refused
([0040](./0040-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md)) — so
repeating the coordinates a dozen times restates something already fixed for the whole answer.

Slots 9 and 10 are exempt, and the exemption is not a concession — each has a reason the prose slots
do not. Slot 9's lines are byte-identical by the promise above, and `deadlockLine` and both
reference-carrying degrade reasons qualify every reference through `formatTicketRef`; shortening them
would be the edit that promise forbids. Slot 10 is a command someone pastes, and a bare reference in
it resolves against whatever checkout they are standing in rather than the one that produced the
answer. Without the exemption an implementation has to break one rule or the other, and the worked
example above already prints both lines qualified.

## The length budget

Twenty-five content lines is the ceiling and today's six is the floor on a run that picked something
— the seven 0038 counts, less its blank. A run that picked nothing floors lower still, at the two
slots that always print, and is not padded up to meet this. Blank lines between slots are not counted anywhere here, and the slots below sum to
twenty-three. The budget is allocated per slot
rather than to the brief as a whole, because slots 3 to 5 are the only ones a model writes and an
unbudgeted brief is one where they absorb everything:

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
reachable: on a pick with an empty body, slots 3 to 5 are absent and the brief is the plain rendering
with slots 6 to 8 around it. The exception is what keeps the rule from deleting the answer on a run
that picked nothing, where every other slot is empty and the headline is the whole point. There is no "no acceptance criteria found" line, because a line saying
nothing was found costs the same as one that found something and is worth less than the blank.

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

**A body with no criteria yields no slot 4.** Scope is a count *and a shape* — "7 items plus 3
guard tests", or the worked example's "a decision between two candidates, plus a status banner" —
and a body carrying neither has no scope to state. Counting the paragraphs, or calling the whole
body the scope, produces a line that is true of every ticket and therefore says nothing.

**With one candidate, slot 6 is omitted.** "It was the only one" is already slot 2's job.

## Consequences

The shipped answer is no longer deterministic end to end, and the scenario fixtures assume it is.
They keep working: they assert `Selection`, and every slot they cover is tool-owned. What they no
longer cover is the whole of what a reader sees. The composed slots need their own control, and
naming it is out of scope here — but a fixture over slots 1, 2, 6, 7, 8, 9 and 10 is the
deterministic half and should stay exact. Slot 8 belongs in that list despite its missing input:
what it needs is an identity, not a judgement, and once supplied the line it writes is as fixed as
the counts.

Nothing here ships yet. `skills/nextup/SKILL.md` still describes relaying the plain rendering, which
is correct until the three missing inputs exist: a skill told to compose slot 3 today would compose
it from the title. [0038](./0038-the-plugin-ships-one-command-and-previews-before-it-starts.md)'s
relay instruction stands until then.

Slot 8 is scoped to the ticket set already read, and says so — "in this repository" — so an empty
slot is not read as "you are holding nothing anywhere". The wider query the motivating example
implied, assigned-to-me across every repository, is refused for the reason
[0040](./0040-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md) refuses a
foreign ticket: the tool's world is the checkout it stands in, and it would be reporting on ticket
sets it has not read and cannot say anything true about. The cost is real — in-flight work
elsewhere is invisible, and that is the case where the line would have mattered most. If the narrow
form proves useless, widening it is a decision of its own with a scope binding and a limit attached.

Two sentences now live in TypeScript that a model would otherwise have written: the tie-break
wording and the compression of the alternatives. That grows `selection-output.ts`, whose 173 lines
of code already carry 114 lines of comment, most of them defending exactly this kind of wording. It is the same trade the repository has already taken
for `degraded: ` and `blockingPhrase` — a sentence a fixture can assert is a sentence that cannot
drift — and the alternative is a model deciding whether six tied candidates were separated.
