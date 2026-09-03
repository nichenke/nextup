# 07 — Runner seam, command builders, and the claim step

**What to build:** The command claims the winning ticket and prints the launch command it *would* run,
creating nothing locally. Introduces the one seam the entire tool is tested through.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Every interaction with an external process goes through a single injected runner interface
- [ ] A stub runner drives the whole tool from in-memory fixtures with no network and no external binaries present
- [ ] External commands are produced by typed command builders, and those builders' outputs are the contract — captured in golden files so a change in what is invoked shows as a reviewable diff
- [ ] Claim is written before any local side effect: claim, verify it landed and is mine, then proceed
- [ ] A claim that cannot land aborts having changed nothing locally
- [ ] Failures before the worktree exists release the claim; the boundary is explicit and tested
- [ ] Markdown claims via its status field, since it has no assignee concept
- [ ] Best-effort by design — no compare-and-swap machinery, no claim expiry
- [ ] `--print-command` emits the launch command without executing it
