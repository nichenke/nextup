# The plugin ships one command, and it previews before it starts

Two manifests made this repository look like a plugin and a store. Neither shipped anything a person
could invoke: the tree held no `commands/`, `skills/` or `agents/` directory that Claude Code would
load, so installing it added a manifest and no way to run the tool. The only documented invocation was
`bun bin/nextup.ts`, a relative path that resolves from inside this checkout and nowhere else.

That mattered because two slash-invocable skills elsewhere are being retired in favour of this tool.
Trading them for an absolute path recalled from memory is the shape of a migration that gets quietly
reverted, so the packaging had to land before the retirement. The selector, the adapter and the
launcher all worked; the gap was never function.

## `dispatch` is the store, and this repository is not one

A marketplace and a plugin are separable, and this repository was both. Being its own store means
every consumer registers a marketplace per tool, and the registration is where a supply-chain
decision is actually made — one entry per repository multiplies the places that decision has to be
taken.

So `.claude-plugin/marketplace.json` is deleted and `.claude-plugin/plugin.json` stays, because the
manifest is what makes a repository a plugin. `dispatch` — already registered by the one consumer
this has — gains a `nextup` entry whose source is this repository's git URL. A marketplace entry's
source may name an external repository rather than a path inside the marketplace's own tree, which is
what lets the entry live there while the code stays here.

The entry is unpinned and tracks the default branch. That is a deliberate loosening: a pin is
protection against a bad commit reaching installs, and the alternative it trades against is a release
branch, which is the shape to reach for if the looseness bites. It also sets the landing order — the
entry resolves against the default branch, so it must not land before that branch carries the
command.

Local work needs no marketplace at all: `claude --plugin-dir <checkout>` loads the plugin from a
working tree, which is why nothing here depends on the entry existing yet.

Anyone who registered this repository as a marketplace while it was one has to drop that registration
and reinstall from `dispatch`: deleting `.claude-plugin/marketplace.json` is what breaks their
refresh.

## A command, not a skill

A skill would let a session reach for this on its own. This tool claims tickets and spawns worktrees
— it writes to somebody else's tracker and to the filesystem — and a session deciding by itself that
now is the moment is a different behaviour from a person typing six characters.

That behaviour may be worth having, and nothing here forecloses it: a skill is additive later. What
it should not be is inherited by accident from the packaging, so the command carries
`disable-model-invocation: true` and the decision stays open rather than being made by the default.

## The command previews, because it cannot ask

The binary is organised around a confirmation gate, and the gate asks on the controlling terminal
rather than on stdin — deliberately, so that `nextup | tee log` still asks. A Claude Code session has
no controlling terminal: opening `/dev/tty` from a tool call fails, `terminal()` returns `null`, and
the run reaches the refusal that says there is nothing to confirm on. Every time, not occasionally.

Nobody is going to re-derive that from the code, so it is written down here: **a session caller
cannot answer the gate.** It must pass `--print-command` or `--yes`. The bare form is unusable from a
session, not merely awkward.

Given that, the command runs `--print-command` once and relays what came back. This is a preview
rather than a start because the flag decides whether anything is written, which makes the default
invocation a safety decision rather than a formatting one. `/nextup` writes nothing until a person
has said so.

Starting is then conversational rather than a second command. The session already holds the
reference, so it runs the binary again naming that ticket with `--yes`. Naming a ticket skips the
ranking and nothing else — [ADR-0037](./0037-naming-a-ticket-skips-the-ranking-and-nothing-else.md)
— so the closed, claimed and blocked checks still gate the start, and the confirmation `--yes`
answers in advance is the one the person just gave. Re-running the ranking instead would be a second
computation that can answer differently from the one they agreed to, which is the whole reason the
override path exists.

## The plain rendering is what gets relayed, not `--json`

`--json` is the larger document, and the instinct is that the plain form is its lossy summary. It is
not. The plain form carries the degrade and deadlock signals under the same stable `degraded: ` and
`deadlock: ` prefixes, names the runner-up the pick beat, and does it in an order of magnitude fewer
lines — seven against a hundred, the larger of which grows with the repository's open-issue count. A session's job here is to hand a person something they can read, so it relays those lines as
they stand.

The prefixes are a contract for exactly this reason, so the command is told to pass them through
rather than fold them into a summary of its own.

## Nothing startable is an answer

A quiet day, an entirely blocked set and a deadlock are three outcomes the tool reports and none of
them is a failure to route around. The command relays the explanation, names the deadlock chain, and
stops. It does not widen the read, re-run with different flags, or propose unblocking anything, and
`--force` is not among the invocations it ships, and a test holds the shipped command to exactly the
two above. It reads every line naming the entry point rather than parsing the markdown around them:
four attempts at a fence grammar each left a shape — an indented fence under a bullet, a tilde fence,
a `shell` info string, an indented block with no fence — where a third invocation still rendered as
something a session would run.

## Consequences

The description in `plugin.json` is the first sentence a person reads when deciding whether to
install, and it promised GitLab and Jira while claiming no adapter was wired at all — both false
since the GitHub adapter landed. It now names GitHub only, names the prerequisites, and names
`/implement` as what the launched session runs. GitLab and Jira come back when their adapters do.

`/implement` is declared and not satisfied. The plugin does not ship it, and a consumer without one
gets a session that opens on a command it does not have — visible immediately, and cheaper than
shipping a second command this repository has no opinion about.

There is no `bun` wrapper script, and nothing new checks for a prerequisite. Two checks already
existed and are worth knowing about when reading the command file: `requireWorkspaceHost` and
`requireSessionBinary` probe `cmux` and `claude` before any write —
[ADR-0035](./0035-a-workspace-host-that-is-not-running-is-refused-before-anything-is-written.md) and
[ADR-0036](./0036-the-launcher-reports-a-request-not-a-running-session.md). `gh` is not probed, but a
missing one is caught at the read, so it too comes back as the tool's own refusal at exit 2. `bun` is
the only one the shell reports, because it is the interpreter. Adding a probe for it would name the
same thing later and less precisely.

The environment-scrub notice — [ADR-0029](./0029-a-git-command-is-given-an-environment-with-no-git-variable-in-it.md)
— prints ahead of the answer on the first git command of any run whose environment carries a
reportable `GIT_` name, which under this sandbox is every run that reaches git. The command is told to skip it on a run that produced an answer and to relay it
on one that failed, because a removed variable may be why the run failed. That is a workaround at the
reading end for something better fixed at the writing end; issue 68 tracks it.
