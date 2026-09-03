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
The system a ticket set lives in — GitHub, GitLab, Jira, or local markdown.
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
Narrower than the blocking graph, which always reads every ticket.
_Avoid_: eligible tickets, shortlist

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

**Ranking ladder**:
The fixed, ordered list of comparison keys that picks a winner from the candidate set. Each rung is
skipped when its signal is absent; the last rung always applies, so the order is total.
_Avoid_: scoring, priority algorithm, heuristic

**Rung**:
One key in the ladder.
_Avoid_: tier, weight, criterion

### Claiming and launching

**Claim**:
The signal, written into the tracker, that a ticket is being worked. An assignee where the tracker has
one; a status field where it does not. Advisory — nothing enforces it.
_Avoid_: lock, reservation, assignment

**Selector**:
The pure layer. Ticket set, claim state, and blocking graph in; ranked candidates with reasons out. No
side effects.
_Avoid_: picker, chooser, engine

**Launcher**:
The layer that writes. Claims the ticket, ensures a worktree, starts a session. The only part that
cannot be sandboxed.
_Avoid_: runner, executor, starter

**Runner**:
The injected seam every external process call passes through. The one place the tool touches anything
outside itself, and therefore the only thing a test has to substitute.
_Avoid_: shell, executor, spawner

**Command contract**:
The exact argv the tool issues to an external program, produced by a typed builder and captured in a
golden file.
_Avoid_: command string, invocation

**Ensure**:
Bringing a worktree into the required state — creating it, or attaching to an existing one at the
expected path. Idempotent, so re-running after a partial failure heals rather than errors.
_Avoid_: create, setup, init

### Boundaries

**Wayfinder ticket**:
A ticket belonging to the wayfinder planning flow, identified by label. Excluded from the candidate set
by default so the two tracks cannot compete for the same ticket — but the filter is a parameter, so
inverting it lets the same selector drive the wayfinder track.
_Avoid_: planning ticket, decision ticket

**Scope binding**:
The record of which tracker and which project a repository's tickets live in, for the one case that
cannot be inferred from a git remote. Holds only that — never ticket state or ranking configuration.
_Avoid_: config, settings, project registry
