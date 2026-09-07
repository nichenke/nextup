# Test tree: GitHub

`nichenke/nextup-test-tree-github` is the synthetic issue tree every GitHub recording is captured from,
and the only repository this tool's write path may run against. ADR-0019 is the rule, ADR-0023 is what
the tree is and why it is built the way it is.

`src/test-tree.ts` is the spec. The tracker is a copy of it, not the source of truth: change the spec,
then run

```sh
bun run provision:test-tree
```

which creates whatever is missing and reports what it changed. Re-running against a matching tree reports
no issue changes; it still re-asserts every label definition, which ADR-0023 explains is the one write
that happens unconditionally and unreported.

## The shapes it carries

One issue per shape, keyed by name rather than by number — a rebuilt tree renumbers. The mapping to live
numbers:

```sh
gh issue list --repo nichenke/nextup-test-tree-github --state all --limit 200 \
  --json number,title,state,assignees,labels --jq 'sort_by(.number)[] | "\(.number)\t\(.state)\t\(.title)"'
```

| Key | Shape it exists for |
| --- | --- |
| `chain-base`, `chain-middle`, `chain-tip` | A chain of open blockers two deep, so propagation has to traverse rather than look one hop |
| `closed-blocker`, `open-blocker`, `mixed-blockers` | One ticket blocked by a closed blocker and an open one, where the open count reads 1 and the total reads 2 |
| `every-blocker-closed` | On the frontier with a blocker total above zero — a reading that consults the total alone calls it blocked |
| `claimed` | Assigned, so outside the candidate set. Never reassign it |
| `no-priority`, `unread-priority` | The priority rung absent, and present but unrankable |
| `needs-triage` | A candidate exclusion the filter is given by hand |
| `excluded-blocker`, `blocked-by-excluded` | A ticket the default filter excludes, still blocking one it admits |
| `cycle-first`, `cycle-second`, `cycle-third` | A three-hop dependency cycle — ADR-0023 has why three and not two |
| `write-target` | The only issue a test may assign and unassign |

The tree holds more open issues than a low fetch limit returns, so truncation is reachable by setting the
limit below its size rather than by adding issues.

## Rules

- **Claim only `write-target`.** Every other issue's assignment is a captured shape. If a run leaves a
  stray claim behind, `bun run provision:test-tree` releases it.
- **Never capture from a real repository.** A shape found in one is recreated here first, per ADR-0019.
  Reading a real repository live is a discovery instrument, not a capture source.
- **Redact before storing**, with `redactRecordingIdentifiers` in `src/recording-identifiers.ts`. ADR-0024
  has why, and why a recording that trips the identifier guard means extending redaction rather than
  allowlisting.
- **Read edges from the dependency endpoint, not the summary field** — `issue-tracker.md` has the commands
  and why the summary cannot be trusted here.
