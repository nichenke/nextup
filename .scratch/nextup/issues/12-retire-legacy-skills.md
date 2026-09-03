# 12 — Confirm v2 live, then delete the two legacy skills

**What to build:** One implementation of ticket selection exists. The two hand-rolled repo-local skills
are gone, deleted only after the replacement has been confirmed working against real repositories — not
on the strength of fixtures.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] The GitHub adapter is exercised live against both repositories that currently carry their own selector, and the picks are compared against what the old skills would have chosen
- [ ] Any divergence is understood and either accepted deliberately or fixed, rather than explained away
- [ ] Both repo-local selector skills are deleted, along with any launcher script they were the only caller of
- [ ] Each affected repository's own documentation points at `nextup` instead
- [ ] Anything the old skills did that the new tool does not is recorded explicitly as dropped, rather than silently lost
