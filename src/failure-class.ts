/**
 * Which of the two failures a tracker CLI just had. An **outage** — connectivity, or the tracker itself
 * erroring — fails open: the caller flags it and continues with less known. A **defect** is the request
 * being wrong, and fails loud, because retrying or degrading past it hides a bug.
 */
export type FailureClass = "outage" | "defect";

// Ported from `ai-bob-brain`'s `plugin/lib/issue-tracker.ts`, except for `error connecting to` and
// `check your internet connection`, which are measured on gh 2.100.0 — see
// `fixtures/recordings/github/read-outage.json`.
const OUTAGE =
	/dial tcp|no such host|could not resolve host|connection refused|i\/o timeout|operation timed out|network is unreachable|tls handshake timeout|HTTP 5[0-9][0-9]|error connecting to|check your internet connection/i;

/** Falls through to defect: an unclassifiable failure read as an outage makes every future defect a silent degrade. */
export function classifyFailure(stderr: string): FailureClass {
	return OUTAGE.test(stderr) ? "outage" : "defect";
}
