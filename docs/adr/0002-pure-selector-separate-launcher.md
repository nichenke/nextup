# The selector is pure and separate from the launcher

The launcher cannot be sandboxed. cmux is driven over a Unix control socket, and creating a workspace
with an arbitrary working directory and command is arbitrary code execution outside any sandbox — so a
sandbox that can reach that socket is not a sandbox. Rather than surrender confinement for the whole
tool, selection is a pure function (ticket set, claim state, and blocking graph in; ranked candidates
with reasons out, as JSON) and the launcher is a thin unsandboxed shell over it, with `--print-command`
as the bridge between them.

## Consequences

The entire tool, launcher included, is testable through one injected process runner: selection has no
side effects, and the launcher's behaviour is fully described by the argv it issues. Those argv are
produced by typed command builders whose output is the contract, captured in golden files.

A single combined command would have made both halves unsandboxable and neither half assertable.
