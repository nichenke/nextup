# The propagation module is copied verbatim, dangling references and all

`src/effective-blockedness.ts` and its test are byte-identical to
`plugin/lib/effective-blockedness.ts` and `plugin/lib/effective-blockedness.test.ts` at
`ai-bob-brain` `origin/main`. Nothing was renamed, reworded, or reformatted, and the 13 copied tests
pass here unchanged.

Keeping it byte-identical means `diff` against the source answers "has this drifted?" outright. Any
edit, however cosmetic, replaces that check with a reviewer reading two files side by side and
judging whether a difference is a port or a divergence. The module is a pure graph traversal over an
injected port with zero tracker coupling, so there is nothing it needs adapted.

Two things are inherited rather than chosen, and both are the price of the above:

- Its header cites `ADR-0014`, `ADR-0010`, and `openspec/changes/program-lifecycle-ordering-model`.
  Those are `ai-bob-brain`'s, and none exists here. Read them as provenance pointers into the source
  repository, not as citations of this repo's `docs/adr/`.
- It names the graph's node type `IssueId`, and speaks of containment `parent` edges up a tier
  ladder. `CONTEXT.md` lists "issue" under _Avoid_ for **Ticket**, and this project has no tier
  ladder in any tracker. So `IssueId` is the graph's internal node identity only: `ticketId()` in
  `src/ticket.ts` is the one place a `TicketRef` becomes one, and no other module should introduce
  the term.

`GraphStore` and `buildGraph` are a different case, and `src/graph-store.ts` is a **port, not a
verbatim copy** — it is re-indented, its two declarations are exported rather than file-private, and
it gains an `emptyGraphStore()` constructor. Diffing it against the source therefore proves nothing,
which is why its trimmed doc comments cost nothing either. What stayed behind is the fetch layer they
were private to: board enumeration, board-status reconciliation, and tier handling, all deleted
outright. Only the tracker-agnostic accessor construction came across.

## Consequences

An upstream fix to the traversal can be taken by copying the file again. If a change is ever needed
that upstream will not take, this ADR is what has to be superseded first — and the two inherited
oddities above stop being a price worth paying at that point, because the diffability they buy is
already gone.

Preserving the deep-traversal / shallow-adapter split is a requirement of this project, not an
incidental property of the copy. A tracker-specific concern that reaches into
`effective-blockedness.ts` has broken the thing that made a board-coupled selector seed a
four-tracker one.
