---
description: Show the next ticket to work on — the pick, why it won, and the counts — then ask before starting it
disable-model-invocation: true
---

Run the selector once, relay what it says, and ask. This step starts nothing.

## Preview

Run this from the repository the user is working in — the tool reads the tracker the `origin` remote
points at, so the working directory is what chooses the ticket set:

```sh
bun ${CLAUDE_PLUGIN_ROOT}/bin/nextup.ts --print-command
```

Run it exactly once. It writes nothing: no claim, no worktree, no session.

Relay what came back, in the tool's own words:

- the pick — its reference, title and URL
- the line saying what it won on, and which ticket it beat
- the line carrying its priority, its `unblocks` count and its blocking phrase
- the counts line — how many tickets were read, filtered out, and left as candidates
- every line beginning `degraded: ` or `deadlock: `

Those prefixes are a stable contract. Pass them through rather than paraphrasing them into your own
summary; a person greps for them.

A leading notice about `GIT_` variables removed from the environment is not part of the answer. Skip it.

Then ask whether to start the pick, and wait. Do not start it because the user asked for `/nextup`.

## Starting

Only once the user has agreed. Start the ticket the preview named, by its reference:

```sh
bun ${CLAUDE_PLUGIN_ROOT}/bin/nextup.ts <ticket> --yes
```

`<ticket>` is the reference the preview printed — or the one it named as the runner-up, if that is the
one the user chose. Starting by reference still runs the closed, claimed and blocked checks, so the
start can still come back refused. Relay a refusal as it stands rather than trying again.

Do not re-run the preview to decide what to start. The first run already produced the reference, and a
second ranking can answer differently.

`--yes` is what makes the start reachable: the tool asks for confirmation on the controlling terminal,
and a session has none, so a run without it is refused rather than answered. The confirmation is the one
you already took from the user.

## When there is nothing to start

The tool reports a quiet day, an entirely blocked set, or a dependency cycle. Relay its explanation,
including every `deadlock: ` line and the chain each names, and stop there.

Do not offer to get around it. Do not re-run with different flags, widen the read, suggest unblocking a
ticket, or start something the tool did not put forward. A set with nothing ready is an answer.

## When a binary is missing

Nothing here checks for one. Report the shell's own error as it stands rather than working around it
or substituting another tool.
