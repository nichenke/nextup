# 01 — Create and bootstrap the `nextup` repo

**What to build:** A public GitHub repository named `nextup` under the personal namespace, with branch
protection enabled, that can be installed as a Claude Code plugin from a local working tree and whose
CI gate is green. Nothing functional yet — this is the container everything else lands in.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Public repo `nextup` exists under the personal namespace, with branch protection on the default branch
- [x] Plugin manifest present and the plugin installs and loads via a local marketplace / `--plugin-dir` — both `plugin.json` and `marketplace.json` pass `claude plugin validate`
- [x] Bun package skeleton with `bun test` and `bunx tsc --noEmit` both runnable and both passing
- [x] CI runs `bun test`, `bunx tsc --noEmit`, and a synthetic-identifier allowlist check, all required
- [x] The allowlist check fails the build on any hostname or issue-key pattern outside a fixed synthetic set — it must exist before any fixture lands
- [x] CI requires no credentials of any kind
- [x] Repo description reads "Unblocked Opportunist — picks the best unclaimed, unblocked ticket and starts work on it"

## Notes

The guard was validated the hard way. It caught a self-reference bug in its own key pattern, then
missed a private registry host that `bun install` wrote into the lockfile *after* the guard had been run
by hand — and CI, which ordered the guard after `bun install`, never reached it because the install
itself failed on that same registry. Three fixes came out of it: the guard runs first in CI, before any
install; `bunfig.toml` pins the public registry so a lockfile cannot record whatever mirror a machine
resolves through; and a local pre-commit hook runs the guard against the staged index.

Remediation: the repo was made private, the single commit was amended clean, and the history was
force-pushed with protection briefly lifted and then restored. The superseded commit remains fetchable
by SHA, which is the residual risk of amending rather than recreating the repo.

