/**
 * The priority rung's signal, read from labels. A lower `rank` is more urgent, matching how the
 * `P0`/`P1` spelling already reads; `null` is no signal at all, which sorts after every candidate that
 * carries one and skips the rung only when neither does — see ADR-0011. `unread` holds
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
			const value = rankable(numbered[1]);
			if (value === null) unread.add(trimmed.toLowerCase());
			else if (rank === null || value < rank) rank = value;
			continue;
		}
		if (NAMED.test(trimmed)) unread.add(trimmed.toLowerCase());
	}

	return { rank, unread: [...unread].sort() };
}

/**
 * The digit run as a number, or `null` above `Number.MAX_SAFE_INTEGER`; ADR-0011 says why that range is
 * reported rather than ranked.
 *
 * The check is sound for a digit run specifically, which is all `NUMBERED` captures: every integer at
 * or below 2^53-1 is representable, so nothing rankable is refused. Widening `NUMBERED` past `\d+`
 * breaks that — a fraction or an exponent can pass `isSafeInteger` after losing precision.
 */
function rankable(digits: string): number | null {
	const value = Number(digits);
	return Number.isSafeInteger(value) ? value : null;
}
