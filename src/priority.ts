/**
 * The priority rung's signal, read from labels. A lower `rank` is more urgent, matching how the
 * `P0`/`P1` spelling already reads; `null` is no signal at all, which the ladder skips. `unread` holds
 * the priority-shaped labels this reading could not order, deduplicated, folded to lower case, and
 * sorted. ADR-0011 says why those are reported rather than ranked.
 */
export interface PriorityReading {
	readonly rank: number | null;
	readonly unread: readonly string[];
}

// The two spellings the spec names, and no others.
const NUMBERED = /^(?:p|priority\s*:\s*)(\d+)$/i;
const NAMED = /^priority\s*:\s*(.*)$/i;

export function readPriority(labels: readonly string[]): PriorityReading {
	let rank: number | null = null;
	const unread = new Set<string>();

	for (const label of labels) {
		const trimmed = label.trim();
		const numbered = NUMBERED.exec(trimmed);
		if (numbered?.[1] !== undefined) {
			const value = exactly(numbered[1]);
			// A digit run too long to hold exactly is reported rather than ranked, like a named value: it
			// is a priority this reading could not order, and the `unread` channel already means that.
			if (value === null) unread.add(trimmed.toLowerCase());
			else if (rank === null || value < rank) rank = value;
			continue;
		}
		if (NAMED.test(trimmed)) unread.add(trimmed.toLowerCase());
	}

	return { rank, unread: [...unread].sort() };
}

/**
 * The digit run as a number, or `null` where `Number` cannot hold it exactly. Nothing bounds how many
 * digits a label carries, and past 2^53 the conversion is lossy in a way that ranks silently wrong:
 * `P9007199254740993` and `P9007199254740992` both become the same value, and a few hundred digits
 * become `Infinity`, so two distinct priorities compare equal and the rung hands the decision on.
 *
 * The round trip is the test rather than `Number.isSafeInteger`, which the first of those pairs passes
 * — it lands exactly on a representable integer, just not its own.
 */
function exactly(digits: string): number | null {
	const value = Number(digits);
	return String(value) === digits.replace(/^0+(?=\d)/, "") ? value : null;
}
