/**
 * Which of the two failures a tracker CLI just had. An **outage** — connectivity, or the tracker itself
 * erroring — fails open: the caller flags it and continues with less known. A **defect** is the request
 * being wrong, and fails loud, because retrying or degrading past it hides a bug.
 */
export type FailureClass = "outage" | "defect";

// Ported from `ai-bob-brain`'s `plugin/lib/issue-tracker.ts`, whose alternation is the first six
// alternatives below. The seventh and eighth are measured on gh 2.100.0 rather than harvested: an
// unresolvable host produced `error connecting to <host>` followed by `check your internet connection`,
// and matched none of the ported alternatives, so a real outage classified as a defect and would have
// failed the run loud instead of degrading it. Both lines are matched because either alone is the whole
// signal in some other CLI's wording, and neither appears in a message about a malformed request.
const OUTAGE =
	/dial tcp|no such host|could not resolve host|connection refused|i\/o timeout|operation timed out|network is unreachable|tls handshake timeout|HTTP 5[0-9][0-9]|error connecting to|check your internet connection/i;

/**
 * Anything not positively an outage is a defect, never the reverse — an unclassifiable failure read as an
 * outage turns every future defect into a silent degrade, so the fall-through direction is the design.
 */
export function classifyFailure(stderr: string): FailureClass {
	return OUTAGE.test(stderr) ? "outage" : "defect";
}
