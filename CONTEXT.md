# nextup

Selects the next piece of work from a ticket set and starts a session on it. This glossary exists
because the same concepts already carry three different names across the implementations `nextup`
replaces, and the disagreements were substantive rather than cosmetic.

## Language

### Tickets and references

**Ticket**:
One unit of work in a tracker, normalized to a common shape regardless of which tracker it came from:
reference, title, state, claim, blockers, url, labels.
_Avoid_: issue, card, story, task

**TicketRef**:
The normalized identity of a single ticket. Written as a scheme-prefixed short form, or parsed from a
pasted issue URL.
_Avoid_: ticket ID, issue number, key

**Tracker**:
The system a ticket set lives in — GitHub, GitLab, or Jira.
_Avoid_: backend, provider, source of truth

**Adapter**:
The per-tracker code that turns that tracker's responses into normalized tickets and blocking edges. The
shallow layer at the tracker boundary, deliberately swappable.
_Avoid_: client, driver, connector

### Selection

**Ticket set**:
The tickets a single invocation considers. A scoped query is a valid ticket set; no declaring artifact
is required.
_Avoid_: backlog, queue, ticket map

**Candidate set**:
The subset of the ticket set eligible to be recommended — open, unclaimed, and passing the label filter.
Narrower than the blocking graph, which always reads every ticket. The excluded labels are read without
being interpreted: `needs-triage` marks both a ticket nobody has triaged and one held up by something
that is not a ticket, and the filter asks only whether a ticket is excluded, never why.
_Avoid_: eligible tickets, shortlist

There is deliberately no term for a tracker's own scoping unit. **Ticket set** covers the tickets one
invocation considers and **Scope binding** covers the one case that cannot be inferred; a third term
would overlap both. "Project" is specifically unavailable — it is GitHub's name for the boards this
design rejects, so using it for our own concept would name the concept after the mechanism refused.
Where a tracker's own noun is meant, say "a Jira project" or "a GitLab project" as that tracker's word.

**Blocking graph**:
The directed graph of blocking edges over *every* ticket, including tickets excluded from the candidate
set. A ticket excluded from candidates still blocks.
_Avoid_: dependency tree, DAG

**Blocker**:
A ticket that must close before another can start.
_Avoid_: dependency, prerequisite, parent

**Unknown**:
The third state of blocking, distinct from blocked and unblocked: the tracker could not tell us. Never
collapsed into either of the other two.
_Avoid_: unresolved, indeterminate, null

**Frontier**:
The tickets whose blockers are all closed — open, unblocked, unclaimed.
_Avoid_: ready tickets, available work

**Deadlock**:
A set of tickets that block each other in a loop, so no order of work opens them. What tells an empty
candidate set that will open up on its own from one that never will. Its **cycle** is the loop named ticket
by ticket, each blocked by the next.
_Avoid_: circular dependency, stuck, unresolvable

**Ranking ladder**:
The fixed, ordered list of comparison keys that picks a winner from the candidate set. Each rung is
skipped when its signal is absent; the last rung always applies, so the order is total.
_Avoid_: scoring, priority algorithm, heuristic

**Rung**:
One key in the ladder.
_Avoid_: tier, weight, criterion

**Override**:
A ticket named on the command line, which skips the ranking ladder and the candidate filter — both of which
decide only what may be *recommended* — and starts that ticket. The checks about whether work can start on it
stay: closed, claimed, and confirmed blocked.
_Avoid_: manual pick, bypass, direct start

**Force**:
The instruction to start an override past the checks that can be overruled — ADR-0037 has which those are and
what it still does. Names the flag and the decision, not the path: the path is **Override**, which exists with
or without it.
_Avoid_: skip checks, unsafe mode

**Target**:
The ticket an override names, with its blocking state. Deliberately not a **candidate**: nothing ranked it, so
it has no runner-up, no deciding rung and no unblocks count, and unlike a candidate it may be confirmed blocked.
_Avoid_: pick, candidate, selection

**Refusal**:
One check an override failed, and the reason reported for it. Every failed check is named rather than the first,
so fixing one does not reveal the next.
_Avoid_: error, rejection, validation failure

### Claiming and launching

**Claim**:
The signal, written into the tracker, that a ticket is being worked: the assignee, which every remaining
tracker has. Advisory — nothing enforces it, and it does not distinguish concurrent sessions.
_Avoid_: lock, reservation, assignment

**Selector**:
The pure layer. Ticket set, claim state, and blocking graph in; ranked candidates with reasons out. No
side effects.
_Avoid_: picker, chooser, engine

**Launcher**:
The layer that writes. Ensures a worktree, claims the ticket, starts a session, in that order. The only
part that cannot be sandboxed.
_Avoid_: runner, executor, starter

**Runner**:
The injected seam every external process call passes through, and therefore the only thing a test has to
substitute. The one place the tool touches anything outside itself, with two audited exceptions under `scripts/` that
ADR-0029 names: the identifier guard, which CI runs before any dependency install and so cannot import this,
and the guard's own test harness, which needs a working directory this seam does not carry.
_Avoid_: shell, executor, spawner

**Ensure**:
Bringing a worktree into the required state — creating it, or attaching to an existing one at the
expected path. Idempotent, so re-running after a partial failure heals rather than errors.
_Avoid_: create, setup, init

**Workspace**:
The thing a started session runs inside, created in the ticket's worktree. One per start.
_Avoid_: session, pane, tab, window

**Workspace host**:
The program that creates workspaces, which the launcher drives as a subprocess like any tracker CLI.
Required rather than optional: one that does not answer fails the run — ADR-0035.
_Avoid_: terminal, multiplexer, backend, fallback host

### Testing against real trackers

**Test tree**:
A dedicated repository of synthetic issues, shaped deliberately to carry the cases worth covering. The
only thing fixtures are ever captured from.
_Avoid_: fixture repo, sandbox, staging

**Recording**:
One captured call-and-response exchange at the runner seam, stored with the CLI version that produced
it, so a change in what the CLI prints is attributable rather than mysterious.
_Avoid_: cassette, golden file, snapshot

**Replay corpus**:
The set of recordings a test suite drives. It grows only from reality: a shape found live is recreated on
a test tree and captured there, never hand-written.
_Avoid_: fixtures, mocks

**Reconstruction**:
Reading a real repository live and asserting invariants over the result rather than exact values — every
reference parses, every blocker resolves to a known ticket or to `Unknown`, counts reconcile. The primary
control, because it is the only one that finds shapes nobody imagined.
_Avoid_: smoke test, integration test, live test

### Boundaries

**Wayfinder ticket**:
A ticket belonging to the wayfinder planning flow, identified by label. Excluded from the candidate set
by default so the two tracks cannot compete for the same ticket — but the filter is a parameter, so
inverting it lets the same selector drive the wayfinder track.
_Avoid_: planning ticket, decision ticket

**Scope binding**:
The record of which tracker and which project a repository's tickets live in, for the one case that
cannot be inferred from a git remote. Holds only that — never ticket state or ranking configuration.
_Avoid_: config, settings, project registry, checkout identity

**Checkout identity**:
Which repository the checkout a command was invoked in *is*, resolved once per run from the origin
remote. About the checkout rather than about a ticket — a **TicketRef** names a ticket, and `ticketId`
already uses "identity" for a ticket's graph key. Distinct from **Scope binding**, which records what
cannot be inferred from a remote; this is what *is* inferred from one.
_Avoid_: repo identity, origin, current repo, scope binding
