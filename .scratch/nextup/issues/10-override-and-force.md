# 10 — Override path and `--force`

**What to build:** Naming a ticket directly skips the ranking but keeps the checks that matter, because
naming a ticket by hand is exactly the path where the frontier query gets bypassed.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] A supplied reference targets that ticket and skips ranking entirely
- [ ] The blocked check and the claimed check still apply, and a blocked or claimed ticket is refused with a clear reason
- [ ] `--force` proceeds past those checks with a loud warning
- [ ] `--force` still claims the ticket, since skipping the block check is a judgment call while skipping the claim only makes the work invisible to others
- [ ] Accepts both short scheme forms and pasted URLs
