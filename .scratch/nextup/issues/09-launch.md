# 09 — Launch: cmux, terminal fallback, confirm gate

**What to build:** End-to-end. The command picks a ticket, claims it, prepares its worktree, and starts
a session working on it. This completes v1.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] Creates a workspace running the session in the ticket's worktree
- [ ] Falls back to opening a new terminal when the workspace host is not running, so a dependency being down does not block the work
- [ ] The task is handed over as a command-line argument carrying the ticket reference — not as a briefing file, which would inject the selector's own reasoning into the new session and bias it toward whichever framing won the ranking
- [ ] The launched slash command is parameterized, defaulting to the implement verb, so the same tool can start an implementation, a triage, or a research session
- [ ] A confirmation gate is on by default and `--yes` skips it
- [ ] `--print-command` remains as the sandbox-safe path
- [ ] Documented plainly: the launcher cannot be sandboxed, because workspace creation with an arbitrary working directory and command is arbitrary code execution outside any sandbox
- [ ] Launch behaviour is verified by asserting issued argv; nothing is actually launched in CI
