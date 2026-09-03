# 06 — Candidate filter, ranking ladder, selector output

**What to build:** Running the command prints which ticket to start next and why, with no writes of any
kind. This is the whole value of the tool, and it is a pure function — the same ticket set always yields
the same answer.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Candidate set is open plus unclaimed, where unclaimed means strictly unassigned
- [ ] `--include` and `--exclude` label filters, defaulting to excluding wayfinder-labelled tickets, so the backlog track and the wayfinder track cannot compete for the same ticket
- [ ] The label filter applies to *candidates only* — the blocking graph always reads every ticket, so a candidate blocked solely by an excluded ticket is still correctly reported blocked
- [ ] Ranking ladder, fixed in code and not configurable: priority signal, then unblocks-count descending, then ticket number ascending as the terminal rung guaranteeing a total order
- [ ] Each rung is skipped when its signal is absent
- [ ] Tickets with unknown blocking state sort last within their rung
- [ ] No model participates in the decision; the output explains which rung decided it
- [ ] A truncated fetch reports itself as truncated rather than presenting a partial set as complete
- [ ] Output is JSON plus a human rendering carrying a greppable degraded sentinel
- [ ] A golden-file scenario suite exists — paired input and expected-output fixtures — and is the documented way to fix a bad pick
