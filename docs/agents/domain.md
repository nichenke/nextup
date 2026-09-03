# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is single-context:

```
/
├── CONTEXT.md
├── docs/adr/
│   └── NNNN-<slug>.md    ← one per decision; list them with `ls docs/adr/`
└── scripts/
```

The ADRs are deliberately not enumerated here. An earlier version of this section listed four, and two
more landed the same day — one from another branch — so an agent reading it would have missed both the
worktree-cleanup and identifier-guard constraints.

A multi-context layout — a root `CONTEXT-MAP.md` pointing at per-context `CONTEXT.md` files, with
`src/<context>/docs/adr/` for context-scoped decisions — is what to switch to if this ever becomes a
multi-package repo. It is not the layout today.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids — it lists them under `_Avoid_` precisely because three prior implementations disagreed on
them substantively rather than cosmetically.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (ranking ladder fixed in code) — but worth reopening because…_
