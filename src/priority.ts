/**
 * The priority rung's signal, read from labels. A lower `rank` is more urgent, matching how the
 * `P0`/`P1` spelling already reads; `null` is no signal at all, which the ladder skips.
 *
 * `unread` holds the priority-shaped labels this reading could not order — deduplicated, folded to
 * lower case, and sorted. It exists so that a pick a person disagrees with can be traced to a label
 * the ladder never read, rather than looking like the ladder read it and disagreed.
 */
export interface PriorityReading {
	readonly rank: number | null;
	readonly unread: readonly string[];
}

// The two spellings the spec names, and no others. `P<n>` is the GitHub and GitLab convention; the
// `priority:<n>` form is the same signal written as a namespaced label.
const NUMBERED = /^(?:p|priority\s*:\s*)(\d+)$/i;
// A `priority:` label whose value is not a number. Ordering `high` against `urgent` needs a
// vocabulary no tracker supplies, and inventing one here would silently reorder a backlog against
// what its author meant, so this is reported rather than guessed at.
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
