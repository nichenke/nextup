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
// The rest of the additions cover a connection that fails *after* it is established, which every ported
// alternative misses: they name pre-connection failures — resolution, dialling, the handshake — so a socket
// reset, a truncated response, or a deadline struck mid-request classified as a defect and aborted the read
// that should have flagged an outage and continued. A rate limit is here for the same reason: being told to
// slow down is not a request that is wrong, and the wording is narrow enough that a permanent 403 — no
// access, resource not accessible — still falls through to defect.
const OUTAGE =
	/dial tcp|no such host|could not resolve host|connection refused|i\/o timeout|operation timed out|network is unreachable|tls handshake timeout|HTTP 5[0-9][0-9]|error connecting to|check your internet connection|connection reset|broken pipe|\beof\b|context deadline exceeded|client\.timeout|rate limit/i;

/** Falls through to defect: an unclassifiable failure read as an outage makes every future defect a silent degrade. */
export function classifyFailure(stderr: string): FailureClass {
	return OUTAGE.test(stderr) ? "outage" : "defect";
}
