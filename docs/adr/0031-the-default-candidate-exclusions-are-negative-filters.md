# The default candidate exclusions are negative filters

`DEFAULT_LABEL_FILTER` excludes three labels and requires none: `wayfinder:*`, `needs-triage`, and `spec`.
`--exclude` adds to that floor rather than replacing it, so `--include backend` cannot hand out a wayfinder
ticket that happens to be labelled `backend`.

- **`wayfinder:*`** keeps the planning and delivery tracks from competing for one ticket. The filter is a
  parameter rather than a rule, which is what still lets the same selector drive the wayfinder track by
  inverting it — `CONTEXT.md`'s **Wayfinder ticket** is where that reading lives.
- **`needs-triage`** is excluded rather than ranked last. An untriaged ticket is a wrong recommendation, not
  a less urgent one, and since no prose blocker parsing exists it is also the only expression a repository
  has for "held up by something that is not a ticket". The filter reads the label without deciding which of
  the two it means — `CONTEXT.md`'s **Candidate set** says that is deliberate.
- **`spec`** was found by running the frontier query against this repository by hand. Issue 2 parents
  eighteen of its twenty-four issues, carries no blockers and is unassigned, so it is unblocked, unclaimed
  and top of its own frontier: without the exclusion the tool recommends starting work on its own
  specification.

## Why none of them is a positive requirement

A positive requirement such as `ready-for-agent` would return nothing at all on every repository whose
label conventions we do not set, which is most of them — and it would fail closed and silently, as an empty
candidate set indistinguishable from a fully blocked one. Excluding a label a repository does not use is a
no-op, so the default costs nothing to carry and portability needs no per-repository configuration.

## Consequences

All three are whole labels except the wayfinder prefix, so a repository's own `specification` or
`needs-triage-review` is ordinary work. That follows from the grammar in `label-filter.ts` rather than from
anything here, and the test names it so a widening to a prefix arrives as a failure.

The exclusions narrow only what may be recommended. The blocking graph still spans every ticket, so an
excluded ticket still blocks — and, per [0030](./0030-a-deadlock-is-named-beside-the-answer.md), can be
named in a deadlock the candidates are blocked behind.

`--exclude` cannot be emptied. A caller wanting the wayfinder track has to say so through the filter
parameter in code rather than through the flag, which is what keeps the flag from being the way a run
recommends a specification.
