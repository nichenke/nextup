# Specification

Canonical spec for `nextup`. Originally filed as nichenke/ai-configs#55, which now points here.

## Problem Statement

I keep rebuilding the same tool. Picking the next piece of work out of a ticket set — finding what is
open, unclaimed, and not blocked, deciding which of those is the best one to start, then getting a
session running on it in its own worktree — currently exists as three incompatible implementations,
and none of them works on more than one tracker.

- `agent-bakeoff` has a `next-build-ticket` skill plus `scripts/start-ticket.sh`. GitHub only. Ranks by
  a critical-path depth parsed out of a `**Longest chain**` line in the map issue's body. Assumes the
  GitHub dependencies API is always available.
- `harness-config` has a `next-ticket` skill plus its own `scripts/start-ticket.sh`, adapted from the
  first. GitHub only. Ranks by whatever order the API returned, and says so explicitly, because its
  map carries no ranking metadata.
- `ai-bob-brain` has `brain next`, a typed TypeScript selector with a real transitive blocking graph
  and genuine fixture-driven tests. It is the most rigorous of the three and the most narrowly
  coupled: it requires a GitHub Projects v2 board, a `PROJECT.md` scaffold, and an invented `tier`
  enum.

So three selectors, three mutually incompatible ranking rules, and two incompatible definitions of
what "claimed" means. Meanwhile a GitLab-hosted project of mine — which has a real ticket map — has no
selector or launcher at all, because every existing implementation speaks only GitHub.

The wayfinder skill family does not fill this gap. Its entire selection rule is one sentence: *"If the
user named one, use it. Otherwise take the first frontier ticket in order."* No tie-breaking, and not
callable on its own — it is embedded in the interactive `/wayfinder` flow. The two repo-local skills
above are, in practice, the only implementations of that logic that exist.

I work across four trackers: GitHub, GitLab, Jira, and local markdown ticket sets. I want one tool.

## Solution

`nextup` — a plugin providing a single command that reads a ticket set from any of the four trackers,
filters to open + unclaimed + unblocked, ranks the survivors deterministically, and launches a session
on the winner in its own git worktree.

Two layers, deliberately separate:

- **The selector** is a pure function. Inputs: a ticket set, claim state, and a blocking graph. Output:
  ranked candidates with reasons, as JSON. No side effects, no network of its own, no model in the
  decision path. Because it is pure, it can be driven entirely from fixtures and its output can be
  asserted exactly.
- **The launcher** is a thin shell over it: claim the ticket, ensure a worktree, start a session. It is
  the only part that writes anything, and the only part that cannot be sandboxed.

By default the command prints its decision and waits for confirmation. `--yes` skips the gate.
`--print-command` emits what it would run without running it.

The name is `nextup`. Description: *"Unblocked Opportunist — picks the best unclaimed, unblocked ticket
and starts work on it."*

## User Stories

1. As an engineer with a repo full of open issues, I want one command that tells me which ticket to
   start next, so that I stop re-deriving the answer by reading the whole backlog.
2. As an engineer, I want that command to work identically on GitHub, GitLab, Jira, and local markdown,
   so that I learn one tool instead of four.
3. As an engineer, I want the command to run from inside the repo I am working on, so that I do not
   have to name the repo or maintain a registry of projects.
4. As an engineer, I want to paste a ticket URL from my clipboard and have the tool understand it, so
   that I do not have to translate it into a scheme-prefixed reference by hand.
5. As an engineer, I want to name a ticket explicitly with a short reference like `gh:123`, `glab:8`,
   or `jira:ABC-123`, so that overriding the ranking is one short argument.
6. As an engineer, I want the tool to refuse to recommend a ticket that is already assigned to someone,
   so that I do not duplicate work in progress.
7. As an engineer, I want the tool to refuse to recommend a ticket whose blockers are still open, so
   that I do not build on a decision that has not been made.
8. As an engineer, I want the tool to say plainly when it could not determine whether a ticket is
   blocked, so that I can judge the risk instead of being handed a false negative.
9. As an engineer whose repo has the GitHub dependencies API disabled, I want the tool to fall back to
   parsing a `Blocked by:` line from the issue body, so that it still works.
10. As an engineer, I want a ticket whose blocking state is unknown to sort below every ticket that is
    confirmed unblocked, so that it only surfaces when there is nothing better.
11. As an engineer, I want ranking to be deterministic, so that the same ticket set always produces the
    same answer and I can write a test that asserts it.
12. As an engineer, I want to know *why* a ticket won, so that when it picks wrong I can fix the rule
    rather than argue with a black box.
13. As an engineer, I want higher-priority tickets to win when a priority signal exists, so that the
    tool respects the judgment already recorded in the tracker.
14. As an engineer, I want a ticket that unblocks more other tickets to beat one that unblocks fewer,
    so that the tool naturally works toward the critical path without me maintaining a chain diagram.
15. As an engineer, I want the oldest ticket to win an otherwise exact tie, so that the ordering is
    total and nothing sits forever.
16. As an engineer, I want the tool to claim the ticket before creating anything locally, so that a
    failure leaves a visible wrong state in the tracker rather than an invisible orphan on disk.
17. As an engineer, I want a failed claim to abort before any local change, so that re-running is safe.
18. As an engineer, I want a failure *after* the worktree exists to keep the claim, so that a ticket
    with my half-finished branch on it is not advertised as available.
19. As an engineer running several agents at once, I want claims visible in the tracker rather than in
    a local lock file, so that two machines can see each other's work.
20. As an engineer, I want the tool to create a git worktree for the ticket rather than switching my
    primary checkout, so that my primary checkout stays on `main`.
21. As an engineer, I want the tool to warn me when my primary checkout is *not* on `main`, so that
    drift surfaces before I stack another worktree on top of it.
22. As an engineer re-running the command after a partial failure, I want it to attach to the existing
    worktree instead of failing, so that recovery is just running it again.
23. As an engineer, I want the worktree root to be configurable, so that a future Codex launcher can
    use a different location without forking the tool.
24. As an engineer, I want branch names to follow my existing convention, so that the branches this
    tool creates are indistinguishable from the ones I create by hand.
25. As an engineer, I want the tool to launch a cmux workspace running the session, so that the work
    starts without further typing.
26. As an engineer whose cmux is not running, I want it to fall back to opening a new terminal, so that
    a dependency being down does not block me.
27. As an engineer debugging a wrong pick, I want `--print-command` to show me exactly what it would
    run, so that I can inspect without executing.
28. As an engineer, I want to choose which slash command the launched session runs, so that the same
    tool can start an implementation, a triage, or a research session.
29. As an engineer, I want a confirmation gate by default, so that I see the pick before a session
    starts on it.
30. As an engineer running this from a script, I want `--yes` to skip the gate, so that automation is
    possible without a second code path.
31. As an engineer working in a repo that also has wayfinder tickets, I want those excluded by default,
    so that this tool and the wayfinder flow can run in parallel without competing for the same
    tickets.
32. As an engineer, I want the wayfinder exclusion to be a *parameter* rather than a hardcoded rule, so
    that inverting the filter lets the same selector drive the wayfinder track too.
33. As an engineer, I want the blocking graph to see wayfinder tickets even when they are excluded from
    candidates, so that a backlog ticket blocked by an open decision is correctly reported blocked.
34. As an engineer with a large backlog, I want a truncated fetch to report itself as truncated, so
    that a partial set is never presented as complete.
35. As an engineer, I want Jira to require an explicit project scope, so that the tool never recommends
    another team's work.
36. As an engineer, I do not want to type `--project` every time, so I want the repo-to-project binding
    remembered after I answer once.
37. As an engineer, I want that binding keyed on the git remote rather than the filesystem path, so
    that it works inside worktrees.
38. As an engineer, I want the binding stored outside the repo, so that a work project key never lands
    in a public repository.
39. As an engineer running non-interactively, I want an unscoped Jira invocation to refuse with the
    exact config line to add, rather than blocking on a prompt nobody will answer.
40. As an engineer overriding the ranking, I want the blocked and claimed checks still enforced, so
    that naming a ticket directly does not skip the checks that matter most.
41. As an engineer who genuinely needs to start blocked work, I want `--force` to proceed with a loud
    warning, so that the escape hatch exists but is never accidental.
42. As an engineer using `--force`, I want the ticket claimed anyway, so that my work is still visible
    to others.
43. As a maintainer of this tool, I want every external command to go through one injected runner, so
    that the whole tool including the launcher is testable with no network and no cmux.
44. As a maintainer, I want the exact argv issued to external tools captured in golden files, so that a
    change in what we invoke shows up as a reviewable diff.
45. As a maintainer, I want a scenario suite of input and expected-output fixtures, so that when the
    ranking picks wrong I add a scenario, watch it fail, and fix the rule.
46. As a maintainer of a public repository, I want CI to run with no credentials at all, so that no
    token is ever stored in a public repo's secrets.
47. As a maintainer of a public repository, I want CI to fail on any identifier outside an allowlist of
    synthetic ones, so that work hostnames and project keys cannot be committed.
48. As the author, I want to delete the two existing repo-local skills once this tool has replaced them
    and been confirmed working live, so that there is one implementation of selection.

## Implementation Decisions

**Substrate.** Bun and TypeScript. Bun is already installed and the `brain` plugin already ships
Bun/TS components with per-package `bun test` and `tsc --noEmit`, so this is established precedent, not
a new toolchain. No build step — Bun executes TypeScript directly from a `#!/usr/bin/env bun` shebang.
`bun test` is transpile-only, so `bunx tsc --noEmit` is a separate required gate.

**Packaging.** A new public GitHub repository under my personal namespace, named `nextup`, with branch
protection. Installed via a local marketplace / `--plugin-dir` for live development, so there is no
cached copy that can go stale and silently run superseded ranking rules. Work content must never be
committed to it.

**Harvest from `ai-bob-brain` (`origin/main`).** Note that the local clone is hundreds of commits
behind; read from `origin/main`.
- `effective-blockedness.ts` is copied verbatim. It is a pure module operating on an abstract
  `DependencyGraph` port with tri-state accessors, implementing the propagation rule *open blocker wins
  > unknown wins > unblocked* over a cycle-guarded traversal. It has zero tracker coupling.
- `GraphStore` / `buildGraph` — the generic tri-state map-backed accessor construction — is copied.
- `dependency-graph.ts`'s fetch layer is *ported*, not copied: its own header describes it as the
  shallow adapter at the tracker boundary, deliberately swappable. Board enumeration, board-status
  reconciliation, and tier handling are deleted outright.
- `blocking-edges.ts` is not relevant — it is write-path code for creating blocking edges, not
  selection.
- `worktree.ts`'s `ensure()` semantics are adopted: attach when a worktree for the branch already
  exists at the expected path, with typed refusals for a stale directory and a branch attached
  elsewhere.
- Worktree *removal* is deliberately not implemented, matching the existing decision to leave removal
  to the harness's native session-exit prompt.
- The scheme-tagging in `agent-bakeoff`'s `TicketRef` (on an unmerged branch) is harvested for
  reference parsing rather than reinvented.

**Ticket model.** One normalized ticket carrying: `ref`, `title`, `state`, `claim`, `blockers`, `url`,
`labels`. Deliberately no size field. Priority is present-or-absent rather than universal.

**Reference grammar.** Two forms, both accepted. A short scheme-prefixed form (`gh:123`, `glab:8`,
`jira:ABC-123`, and a markdown ticket number) where GitHub and GitLab resolve the repository from the
working directory. And a pasted issue URL. URL resolution is by *shape* first — GitLab issue paths
contain `/-/issues/`, GitHub's contain `/issues/`, Jira's contain `/browse/<KEY>-<n>` — because shape is
a fact about the product rather than about any employer, so it is safe to publish and needs no
configuration. Where shape is ambiguous, the installed CLIs' own authenticated-host state disambiguates.
A URL for a host nothing is authenticated to fails loudly rather than being guessed. Note that the Jira
config stores an API-gateway host, not the browse host a pasted link shows, so hostname comparison
against it does not work and the `/browse/` shape is the reliable signal.

**Tracker adapters.** Four fetch implementations behind the single `DependencyGraph` port. The port
interface is designed against the *weakest* tracker's constraints — GitHub, which may have its
dependencies API disabled, has no priority field, and offers only labels — so that no adapter has to
widen it. Each adapter decides its own failure-to-`unknown` mapping while reusing the shared
propagation module.

**Blocking is tri-state.** Blockers resolve to a list *or* `unknown`, and `unknown` is never collapsed
to "not blocked." Per-source fallback ladders run before `unknown` is reached: for GitHub, the native
dependencies API, then a `Blocked by:` line parsed from the issue body, then `unknown`. Tracker
open/closed state is canonical and is re-read per ticket — a denormalized or board-cached status is
never trusted. An unavailable endpoint is an outage: flag and continue. A 4xx is a defect: fail loud.

**Ranking ladder**, fixed in code and not configurable, each rung skipped when its signal is absent:
1. Priority signal — Jira's Priority field, or a `P0`/`P1`/`priority:*` label elsewhere.
2. Unblocks-count descending — out-degree in the blocking graph.
3. Ticket number ascending — the terminal rung, always available, guaranteeing a total order.

Tickets whose blocking state is `unknown` sort last within their rung. No model participates in the
decision; a model may narrate the result but never choose it. A configurable ladder is rejected because
it cannot be asserted against a fixture and invites tuning in place of fixing.

**Claiming.** The claim is the assignee for GitHub, GitLab, and Jira — the only signal a second party
can see. For markdown, which has no assignee field, it is a `Status:` line. Order is: claim, verify the
claim landed and is mine, ensure the worktree, launch. Failures before the worktree exists release the
claim; failures after it keep the claim and report the partial state. Best-effort by design — no
compare-and-swap machinery. Claimed-but-not-running is easy to spot and correct by hand, and hardening
is deferred until it demonstrably hurts.

**Wayfinder partition.** The candidate-set label filter is a parameter, not a hardcoded rule.
`--exclude wayfinder:*` is the default, so the backlog track and the wayfinder track partition cleanly
and cannot compete for the same ticket. Inverting the filter lets the same selector drive the wayfinder
track, which is what makes the two existing repo-local skills deletable. The filter applies to
*candidates only* — the blocking graph always reads everything, so a backlog ticket blocked only by an
open wayfinder decision is still correctly reported blocked. For markdown, `Type:` is a ticket kind and
is *not* mapped to a wayfinder label; wayfinder provenance for markdown lives on the map file.

**Markdown format.** Matches what exists in practice: `.scratch/<effort>/map.md` alongside
`.scratch/<effort>/issues/<NN>-<slug>.md`, where `NN` is a two-digit zero-padded number. A ticket
carries an H1 title and `Type:`, `Status:`, and optional `Blocked by:` lines, with `## Question`,
`## Notes`, and `## Answer` sections. Observed `Status` values are `open` and `resolved`; `claimed` is
specified but has no real instances, so it is supported without being assumed. `Blocked by:` references
bare ticket numbers; a comma-separated list is supported per spec though every real instance was a
single number.

**Scope binding config.** A single user-level file outside every repository, keyed on the normalized git
remote slug rather than the filesystem path — worktrees have different paths but the same remote, and
this tool does its work inside worktrees. It may hold *only* scope binding: which tracker, which
project, which host. It may never hold ticket state, ranking configuration, label policy, or workflow
scaffolding; the moment it does, it is a second tracker and a ranking that cannot be fixture-tested.
Precedence is an explicit flag, then the config, then refusal. Repos with no Jira relationship need no
config at all. The first unscoped Jira invocation lists accessible projects, asks which one binds, and
writes the entry; in a non-interactive context it refuses and prints the exact line to add instead.

**Launching.** cmux workspace creation is primary, matching what both existing scripts converged on.
A new-terminal fallback covers cmux not running. `--print-command` emits without executing, which
doubles as the sandbox-safe path. The task is handed over as a CLI argument — the ticket reference —
not as a briefing file: the launched session reads the ticket itself, and a briefing would inject the
selector's own reasoning into the new session's context, biasing it toward whichever framing won the
ranking. The launched slash command is parameterized, defaulting to the implement verb.

**Worktrees.** Root is parametric, defaulting to the harness's worktree directory so that native
session-exit cleanup applies. Branch names follow the existing convention: a feature or fix prefix
determined by a bug label, then slug, then ticket number — number last so tab-completion works on the
slug. Markdown tickets, having a number in the filename, follow the same shape.

**Sandboxing.** The launcher cannot be sandboxed: cmux is driven over a Unix control socket, and
workspace creation with an arbitrary working directory and command is arbitrary code execution outside
any sandbox. Granting a sandboxed process access to that socket defeats the sandbox. Therefore the
launcher runs unsandboxed by design, and the selector — pure reads — is the part that can be confined.
`--print-command` is the bridge between the two.

## Testing Decisions

**A good test here asserts external behavior only:** the JSON the selector emits, and the argv the
launcher issues. Nothing asserts on internal call shapes or private structure.

**One injected seam.** Every interaction with the outside world is a subprocess — the GitHub, GitLab,
and Jira CLIs, `git worktree`, cmux, and the session binary. All of it goes through a single injected
runner interface. Tests drive the CLI entry point with a stub runner and assert both the emitted JSON
and the sequence of argv the runner was asked to execute. That second assertion is what tests the
launcher: claim-before-worktree ordering, release-only-before-worktree-exists, and the exact workspace
creation invocation. Prior art is `ai-bob-brain`'s `GhRunner`/`StubRunner` pair, widened here from "the
GitHub CLI" to "every subprocess."

**The argv contract is explicit.** External commands are built by typed command builders, and those
builders' outputs *are* the contract, captured in golden files. When a real CLI's flags change, one
builder changes and the golden diff shows precisely what moved. This is the module boundary for now; if
it proves too loose, it gets revisited, but the contract must be written down rather than implied.

**Scenario suite as the iteration surface.** A directory of paired input and expected-output fixtures,
where input is the stubbed tracker responses and expected is the ranked result. When the ladder picks
wrong, the scenario is added, watched to fail, and the rule fixed. Deterministic ranking is what makes
an exact expected output possible at all.

**Two deliberate exceptions, neither a second injection point.** The markdown adapter reads real files
in temporary directories rather than through a filesystem port — an abstraction would permit fixtures
that cannot exist on a real disk, and markdown parsing is exactly where a lying fixture is dangerous,
since the format has already diverged from its own specification twice. And `ensure()` gets a real-git
test block in a temporary repository alongside its stubbed argv tests, because its whole purpose is
handling real `git worktree` failure modes that stubbed argv cannot prove.

**Modules under test:** reference parsing and normalization, each tracker adapter's
failure-to-`unknown` mapping, blocking propagation including cycles and unknown precedence, the ranking
ladder at every rung and with signals absent, truncation self-reporting, claim ordering and release
boundaries, worktree attach-versus-create, and command-builder output.

**CI runs with no credentials.** `bun test`, `bunx tsc --noEmit`, and an identifier allowlist check.
Because the whole tool is stub-driven, no token is needed — which matters, since a public repository's
Actions secrets are the wrong place for work credentials.

**Leak prevention is an allowlist, not a denylist.** A denylist of work hostnames would itself be work
content, so publishing the guard would leak what it guards. Instead, fixtures may reference only a
fixed set of synthetic identifiers, and CI fails on anything outside that set — the guard contains no
work strings and catches leaks by construction rather than by enumeration. A local pre-commit denylist
holding the real patterns lives outside the repository, reached via a repo-local hooks path setting, and
is never committed. CI on a protected branch is the actual control; the local hook is a convenience net,
since it is bypassable.

**Live tests are local-only and manual**, optionally wrapped in a sandbox profile restricting egress to
the tracker hosts, so that a bug in a fetch adapter cannot fire a credentialed request somewhere
unintended. A live smoke test in CI against a dedicated public fixture repository is deferred until the
stub fixtures have actually drifted from reality.

## Out of Scope

- **Retiring `ai-bob-brain`.** It is a harvest source only; it keeps running on its own concepts.
- **Stale-claim detection and resume candidates.** The selector reports only the best unclaimed ticket.
- **Map parsing of any kind.** Sequencing intent lives in blocking edges, where it is machine-readable.
  Neither a wave table nor a longest-chain prose line is read.
- **Worktree removal.** Left to the harness's native session-exit prompt, matching the existing
  decision.
- **Enforcing the claim.** A context-injecting hook is not enforcement; only a blocking pre-tool-use
  denial would be, and that is not this tool's job. The claim is advisory.
- **A general record-and-replay harness.** The sandbox tool has an audit trail and a filtering proxy but
  no cassette mechanism. Golden files are the testing environment; the sandbox's role is limited to
  constraining egress on local live tests.
- **Sandboxing the launcher.** Structurally impossible while it drives cmux.
- **Org-scale concerns** — a configuration system, a multi-tenant auth story, a support burden. Built
  for me and my agents, with mechanisms chosen so they would survive multi-user use without a rewrite.
- **Jira set selection in early phases.** Jira arrives as override-only first.

## Further Notes

**Phasing**, each phase shipping something usable:

- **v1** — the spine, end-to-end, markdown only: reference parsing, the copied propagation module, the
  markdown adapter, the three-rung ladder, JSON output, `--print-command`, the launcher with cmux and
  terminal fallback, worktree `ensure()`, claim-first ordering, the golden-file suite, and CI. Zero
  credentials and zero API archaeology, while exercising every piece of the design.
- **v2** — the GitHub adapter.
- **v2.5** — delete `agent-bakeoff`'s `next-build-ticket` and `harness-config`'s `next-ticket`, after
  confirming and testing v2 live. Deletion follows a live confirmation, not fixture evidence alone.
- **v3** — the GitLab adapter. This one fills a gap rather than replacing a duplicate: the
  GitLab-hosted project has a map and no launcher at all.
- **v3.5** — the same confirm-then-delete step for anything v3 supersedes.
- **v4** — Jira, override-only first, then project-scoped set selection.

**The design decision most worth recording as an ADR** is that scope binding lives in a user-level
config keyed on the git remote, and that everything else is either inferred from the working directory
or fixed in code. It is hard to reverse once fixtures and documentation assume it, it is surprising
without context — a reader will ask why there is no in-repo config like every other tool — and it is
the product of a real trade-off against per-repo config and against a central project registry. The
motivating evidence is that a per-repo `PROJECT.md` scaffold is precisely what makes the most rigorous
existing implementation non-portable.

**A note on where the rigor came from.** The propagation module being copyable verbatim is not luck: its
author separated the deep, tracker-agnostic graph logic from a shallow adapter at the tracker boundary
and said so in the file header. That split is the reason a board-coupled selector can seed a
four-tracker one. Preserving that split is a requirement of this work, not an incidental property of it.

