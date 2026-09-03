# Bun and TypeScript, not bash or Python

`nextup` is written in TypeScript and run by Bun, even though the launcher scripts it replaces are bash
and the surrounding tooling leans bash and Python. The deciding factor is that the tri-state blocking
propagation module — a cycle-guarded traversal where an open blocker beats unknown beats unblocked —
already exists, tested, in TypeScript, operating on an abstract graph port with no tracker coupling. It
copies verbatim. Reimplementing tri-state degradation and cycle detection is exactly where the real bugs
would live, so copying beats porting.

## Considered Options

Bash, matching the scripts being replaced, and Python. Either would have turned a copy into a port of
the one module that is already correct.

Bun needs no build step — it executes TypeScript directly from a shebang — so a TypeScript plugin
component stays as script-like as bash, and an existing plugin already ships Bun components here.

## Consequences

`bun test` is transpile-only, so a typecheck is a separate required CI gate rather than something the
test run covers.
