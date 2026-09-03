# 05 — Markdown adapter and blockedness

**What to build:** A real local markdown ticket directory becomes a set of normalized tickets, each with
its blocking state resolved to blocked, unblocked, or unknown. This is the first backend and it needs no
credentials or network at all.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Discovers a markdown effort: a map file alongside an issues directory of numbered ticket files
- [ ] Parses the observed real format — H1 title, and `Type:`, `Status:`, optional `Blocked by:` lines, with question/notes/answer sections
- [ ] Tolerates both the plain-field form observed in real ticket sets and the bold-field form the `to-tickets` skill emits, or normalizes one into the other and documents which
- [ ] `Blocked by:` accepts a bare ticket number and a comma-separated list, resolving references within the same effort
- [ ] Handles `Status:` values `open` and `resolved`, and supports `claimed` without assuming it — it is specified but has no real instances
- [ ] The tri-state propagation module is copied verbatim from the prior art along with its tests, unmodified
- [ ] Blocking state is tri-state and `unknown` is never collapsed to "not blocked"
- [ ] Ticket open/closed state is read per ticket and never taken from a cached or denormalized field
- [ ] Tested against real files in temporary directories, not through a filesystem abstraction
