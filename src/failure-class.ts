import type { CommandResult } from "./runner";

/**
 * Which of the two failures a tracker CLI just had. An **outage** — connectivity, or the tracker itself
 * erroring — fails open: the caller flags it and continues with less known. A **defect** is the request
 * being wrong, and fails loud, because retrying or degrading past it hides a bug.
 */
export type FailureClass = "outage" | "defect";

// Ported from `ai-bob-brain`'s `plugin/lib/issue-tracker.ts`. Two additions are measured on gh 2.100.0 —
// `error connecting to` and `check your internet connection`, in
// `fixtures/recordings/github/read-outage.json`.
//
// `eof` is matched only where a transport error puts it — after a colon, as gh prints it, or in Go's
// `unexpected EOF` — never as a bare word: a repository or field named `eof` appears in a GraphQL message about
// a request that is wrong, and reading that as an outage degrades silently where it has to fail loud.
//
// The rest of the additions cover a connection that fails *after* it is established, which every ported
// alternative misses: they name pre-connection failures — resolution, dialling, the handshake — so a socket
// reset, a truncated response, or a deadline struck mid-request classified as a defect and aborted the read
// that should have flagged an outage and continued. A rate limit is here for the same reason: being told to
// slow down is not a request that is wrong, and the wording is narrow enough that a permanent 403 — no
// access, resource not accessible — still falls through to defect.
const OUTAGE =
	/dial tcp|no such host|could not resolve host|connection refused|i\/o timeout|operation timed out|network is unreachable|tls handshake timeout|HTTP 5[0-9][0-9]|error connecting to|check your internet connection|connection reset|broken pipe|unexpected eof|:\s*eof\b|context deadline exceeded|client\.timeout|rate limit/i;

/** Falls through to defect: an unclassifiable failure read as an outage makes every future defect a silent degrade. */
export function classifyFailure(stderr: string): FailureClass {
	return OUTAGE.test(stderr) ? "outage" : "defect";
}

/**
 * One failed call's stderr as a single line. `gh` writes an error over several, while a degrade or an abort is
 * one event, so every consumer would otherwise have to remember to collapse it again — which is how a newline
 * reached the human rendering while `--json` still carried the raw text.
 *
 * Lives beside `classifyFailure` because the two are always reached together: a caller that classifies a
 * failure is about to report it.
 */
export function collapseFailure(stderr: string): string {
	return stderr.trim().replace(/\s+/g, " ");
}

/**
 * One failed call's whole evidence, for an abort that has nothing else to offer a person.
 *
 * stdout backs up stderr because a CLI may diagnose on either, and the exit code backs up both because a
 * command can exit non-zero having written to neither — which would otherwise abort on a bare colon.
 * Classification stays a question about stderr alone, which is what `classifyFailure` was measured
 * against, so a diagnostic on stdout alone still falls through to the loud class.
 */
export function failureDetail(result: CommandResult): string {
	return collapseFailure(result.stderr) || collapseFailure(result.stdout) || `no output, exit ${result.code}`;
}
