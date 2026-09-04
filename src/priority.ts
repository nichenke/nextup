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
			const value = Number(numbered[1]);
			if (rank === null || value < rank) rank = value;
			continue;
		}
		if (NAMED.test(trimmed)) unread.add(trimmed.toLowerCase());
	}

	return { rank, unread: [...unread].sort() };
}
