# Test tree: GitHub

`nichenke/nextup-test-tree-github` is the synthetic issue tree every GitHub recording is captured from, and
the only repository a **test** may write to. Shipped `nextup` claims tickets in whatever repository it is
pointed at — that is what the tool is for, and `README.md` documents it; this rule binds tests and capture,
not the launcher. ADR-0019 is the rule, ADR-0023 is what the tree is and why it is built the way it is.

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
numbers, deliberately wider than the adapter's own read: that asks `--state open` per ADR-0028, and this asks
for every state so that `closed-blocker` — which a read now meets only as an edge — is still listed here.

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
| `several-priorities` | More than one priority label at once — labels are a set, so the reading has to choose |
| `needs-triage` | A candidate exclusion the filter is given by hand |
| `excluded-blocker`, `blocked-by-excluded` | A ticket the default filter excludes, still blocking one it admits |
| `cycle-first`, `cycle-second`, `cycle-third` | A three-hop dependency cycle — ADR-0023 has why three and not two |
| `write-target` | Reserved for the write path — see the rule below |

The tree holds more open issues than a low fetch limit returns, so truncation is reachable by setting the
limit below its size rather than by adding issues.

## Capturing from it

```sh
bun run capture:github
```

Credentialed and local, never CI. It writes one file per exchange under `fixtures/recordings/github/`,
redacted, and refuses a tree that is not private before it reads anything. The tree is not a parameter, so
there is no invocation of it that reads a real project repository.

Run it after changing what the adapter asks for, and read the diff: a recording that changed without the
query changing is the CLI's projection moving under us, which is what the stored version line is for.

Two of the five captures are failures rather than tree reads — an unresolvable host for the wording an
outage is recognised by, and a repository that does not exist for the wording of a request that is itself
wrong. Each is refused if it stops failing, so a name that later becomes a real repository is never stored.

Do not read those two as evidence that redaction covers a host anywhere it appears. It rewrote the host in
`read-outage.json`'s argv, where a `/` follows it, and left the same host standing in the stderr beside it,
where nothing does — `BARE_HOST` in `src/recording-identifiers.ts` needs that following separator. What makes
the stored copy harmless is the name itself: it is under `.invalid`, which RFC 2606 reserves so that it can
never resolve. A capture naming a real unreachable host would keep it, and redaction is not what would stop
that. The repository path is not rewritten at all — redaction rewrites hosts.

## Rules

- **Leave the repository private.** Provisioning checks and refuses otherwise, before its first write, so
  making it public stops the tool rather than silently widening the tree. Its visibility is a security
  control, not a preference: public means anyone can open an issue under a known spec title or comment on an
  existing one, and provisioning adopts by title while never reconciling bodies, labels or comments. ADR-0023
  has the path and what would have to replace the control.
- **`write-target` is the only issue a test may assign and unassign.** Every other issue's claim is a
  captured shape. If a run leaves a stray claim behind, `bun run provision:test-tree` releases it.
- **Never capture from a real repository** — ADR-0019 is the rule and `CLAUDE.md` carries it into every
  session.
- **Redact before storing**, with `redactRecordingIdentifiers` in `src/recording-identifiers.ts`. ADR-0024
  has why, and why a recording that trips the identifier guard means extending redaction rather than
  allowlisting.
- **Capture `--json` surfaces, not the human-readable views.** Plain `gh issue view` prints its blockers as
  `owner/repo` and a number, which redaction cannot rewrite and the guard rejects; the `--json` form of the
  same query carries no such shape. ADR-0024 has the measurement.
- **Keep issue bodies free of file references** — a dotted filename followed by a colon and a line number,
  or by a slash. Redaction rewrites those to the placeholder because the guard flags them, and measured
  tracker output contains none, so a body is the only way one reaches a recording.
- **Read edges from `blockedBy` or the dependency endpoint, never the summary field** — `issue-tracker.md`
  compares all three and says why the summary cannot be trusted. Capture the surface the adapter will
  actually parse: recording only the per-issue endpoint would leave the bulk `{nodes:[…],totalCount}` shape
  with no recording behind it, and ADR-0019 forbids inventing one.
