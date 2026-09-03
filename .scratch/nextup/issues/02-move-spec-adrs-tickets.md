# 02 — Move the spec, ADRs, and ticket set into `nextup`

**What to build:** The spec, the four ADRs, and this ticket set all live in the `nextup` repo, and the
copies in ai-configs are gone. A reader landing on `nextup` finds the whole design without following a
link to another repository.

**Blocked by:** 01

**Status:** claimed

- [x] The four ADRs are in `nextup` under `docs/adr/` with numbering preserved
- [x] `CONTEXT.md` exists at the repo root as a glossary only — no implementation detail — defining at minimum: TicketRef, claim, blocker, tri-state unknown, candidate set, blocking graph, ranking ladder, frontier
- [x] The spec content is present in `nextup`, either as an issue on its tracker or a document, and the ai-configs issue points at it
- [x] The remaining tickets exist on `nextup`'s tracker with blocking edges preserved, or remain as markdown in `nextup` if the tracker migration is deferred — kept as markdown deliberately, so the ticket set doubles as the markdown adapter's first fixture
- [ ] ai-configs no longer carries the ADRs, the ticket set, or the scratch effort directory — the ai-configs copies live only on an unmerged branch, which is deleted once this lands rather than merged and then reverted
- [x] No work hostname, project key, or ticket identifier appears anywhere in the moved content — the spec named a GitLab-hosted work project twice; both were generalised on the way in
