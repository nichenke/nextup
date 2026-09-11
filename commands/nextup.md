---
description: Show the next ticket to work on — the pick, why it won, and the counts — then ask before starting it
disable-model-invocation: true
---

Run the selector once, relay what it says, and ask. This step starts nothing.

## Preview

Run this from the repository the user is working in — the tool reads the tracker the `origin` remote
points at, so the working directory is what chooses the ticket set:

```sh
bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" --print-command
```

Run it exactly once. It writes nothing: no claim, no worktree, no session.

Relay what came back, in the tool's own words:

- the pick — its reference, title and URL
- the line saying what it won on, and which ticket it beat. With a single candidate there is no
  runner-up and the line says so instead
- the line carrying its priority, its `unblocks` count and its blocking phrase
- the counts line — how many tickets were read, filtered out, and left as candidates
- every line beginning `degraded: ` or `deadlock: `

Those prefixes are a stable contract. Pass them through rather than paraphrasing them into your own
summary; a person greps for them.

The last line is the session command the tool would run. It is there to be read, not run — starting
goes through the tool, below.

Then ask whether to start the pick, and wait. Do not start it because the user asked for `/nextup`.

## What the exit status means

Branch on the status, not on what the text looks like.

- **0** — the tool did what was asked. The answer is on stdout.
- **1** — nothing to recommend. An answer, not a failure, and the `degraded: ` lines are what say
  whether it is the honest kind.
- **2** — something needs a person. Never relay this as an answer. If stdout is empty, nothing was
  selected at all and the whole message is on stderr.

## Starting

Only once the user has agreed. Start the ticket the preview named, by its reference:

```sh
bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" <ticket> --yes
```

`<ticket>` is the reference the preview printed — or the one it named as the runner-up, if that is the
one the user chose. Starting by reference still runs the closed, claimed and blocked checks.

Do not re-run the preview to decide what to start. The first run already produced the reference, and a
second ranking can answer differently.

Keep `--yes`. A session cannot answer the tool's confirmation gate — it asks on the controlling
terminal, and there is none here — so a run without it is refused rather than answered. The
confirmation is the one you already took from the user.

On success the tool says it *asked* the workspace host to run a session. Say the same. Nothing it can
see reports that the session came up.

### When a start does not go through

Two kinds, and they want different things said.

- **A check refused it** — closed, claimed or confirmed-blocked. The message says the ticket was not
  started and that nothing was claimed or created. Relay it and stop.
- **It failed partway** — the workspace host did not answer, the worktree could not be made, the claim
  would not land, the session was refused. These are not verdicts on the ticket, and they do not
  unwind: a failure after the claim leaves the ticket claimed and the worktree on disk. Relay the
  message in full, including whatever it says is already in place, and follow the recovery it gives
  rather than one of your own.

Add no flag the user did not ask for. A refusal may advise `--force`; that is advice for the person,
to run themselves from a checkout, and not a third invocation for you to build.

## When there is nothing to start

Four cases, and the last one is not like the others.

- **A quiet day** — nothing ready.
- **Everything blocked.**
- **A deadlock** — relay every `deadlock: ` line and the chain each names.
- **The tracker could not be read** — a `degraded: ` line says so, and the exit status is still 1. This
  is not a quiet day and must not be relayed as one. Say the read failed, and that retrying is the
  answer.

For the first three: relay the explanation and stop. Do not widen the read, re-run with different
flags, suggest unblocking a ticket, or start something the tool did not put forward. A set with
nothing ready is an answer.

## When a run goes wrong

A leading notice about `GIT_` variables removed from the environment is not part of a successful
answer — skip it when the run produced one on stdout. When the run failed, relay it: those variables
may have carried the only configuration that made git work there, so the notice can be the reason.
Issue 68 tracks the notice itself.

`bun` and `gh` are not checked for; a missing one surfaces as the runner's own error. `cmux` and
`claude` are probed before any write, and a missing one comes back as the tool's own refusal at exit
2. Report whichever arrives as it stands rather than working around it or substituting another tool.

An entry point that cannot be found is not an answer either. A run that reports `Module not found`, or
exits without a counts line, has read nothing — say that rather than that there is no work.
