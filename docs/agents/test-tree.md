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
| `needs-triage` | A ticket the default filter excludes by whole label, rather than by the `wayfinder:` prefix |
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

Run it outside a network-filtering sandbox, and read the two unresolvable-host recordings in the diff first.
A filtering proxy answers the unresolvable host itself rather than letting resolution fail, so the capture stores
the proxy's own refusal where a connectivity error belongs. Measured in a Claude Code sandbox on gh 2.100.0: both
`read-outage` and `claim-outage` came back carrying `Post "<url>": Bad Gateway`, with exit 1 intact, so
`Capture.succeeds` does not catch it and the diff is the only control.

That string is a **defect** to `classifyFailure`, which is the opposite of what those two recordings exist to pin.
The token it turns on is the one the proxy's wording lacks: `HTTP 5xx` is in the outage pattern and a bare
`Bad Gateway` from a transport error is not, so `gh`'s own `HTTP 502: Bad Gateway` rendering would have classified
as an outage and this does not.

Three of the thirteen captures write rather than read: the claim landing on `write-target`, a claim naming an
issue the tree does not have, and a claim against an unresolvable host. They come last, and the run releases
`write-target` on the way out, including out of a capture that threw, because every capture that read the whole
tree recorded it unassigned. A release that itself fails says so **and fails the run**, so a stray claim cannot be mistaken
for a clean capture.

Interrupting the run is the gap: a `finally` does not cover Ctrl-C or a kill. An interrupted run cannot quietly
become a bad corpus, though: the next capture refuses to start against a `write-target` the tree has claimed or
closed, and the release itself checks rather than trusting its own exit status, since removing an assignee
somebody else holds also exits 0.

Provisioning releases a stray claim on any issue the spec describes, not only `write-target` — `reconcileClaim`
runs over every spec issue. The one claim it cannot clear is one landed on an issue the spec describes no shape
for, because `listIssues` refuses an undescribed title before any release happens. Only the failing write capture
could produce that, which is why it names a number the tree cannot reach.

Five captures are failures rather than successful exchanges: an unresolvable host, for the wording an outage
is recognised by, and a request that is itself wrong, for a defect's — the first in a read form and a write
form, the second in those two and in the single-ticket read the override path uses.
Each is refused if it stops failing, so neither a repository nor an issue number that later comes into
existence is ever stored as a success. For the write forms that refusal fires after the call, so it protects
the corpus rather than the tree — which is why the failing claim names a number inside the tree itself.

Do not read the unresolvable ones as evidence that redaction covers a host anywhere it appears. It rewrote the host in
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
- **`write-target` is the only issue a test or a capture may assign and unassign.** Every other issue's claim
  is a captured shape. If a run leaves a stray claim behind, `bun run provision:test-tree` releases it.
- **Never capture from a real repository** — ADR-0019 is the rule and `CLAUDE.md` carries it into every
  session.
- **Redact before storing**, with `redactRecordingIdentifiers` in `src/recording-identifiers.ts`. ADR-0024
  has why, and why a recording that trips the identifier guard means extending redaction rather than
  allowlisting.
- **Capture `--json` surfaces where a query has one, not the human-readable views.** Plain `gh issue view`
  prints its blockers as `owner/repo` and a number, which redaction cannot rewrite and the guard rejects; the
  `--json` form of the same query carries no such shape. ADR-0024 has the measurement. The write captures are
  the exception, because `gh issue edit` has no `--json`: `claim.json` stores the issue address it prints, whose
  host redaction does rewrite.
- **Keep issue bodies free of file references** — a dotted filename followed by a colon and a line number,
  or by a slash. Redaction rewrites those to the placeholder because the guard flags them, and measured
  tracker output contains none, so a body is the only way one reaches a recording.
- **Read edges from `blockedBy` or the dependency endpoint, never the summary field** — `issue-tracker.md`
  compares all three and says why the summary cannot be trusted. Capture the surface the adapter will
  actually parse: recording only the per-issue endpoint would leave the bulk `{nodes:[…],totalCount}` shape
  with no recording behind it, and ADR-0019 forbids inventing one.
