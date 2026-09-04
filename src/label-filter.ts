export class LabelFilterError extends Error {}

/**
 * The label filter as a user wrote it, and as output echoes it back. `include` empty admits every
 * label; a non-empty `include` admits only a ticket carrying one of them. `exclude` always wins.
 *
 * This is the parameter that partitions the backlog track from the wayfinder track, per CONTEXT.md's
 * **Wayfinder ticket**. It is deliberately a parameter rather than a rule in code: inverting it is
 * what lets the same selector drive the wayfinder track.
 */
export interface LabelFilterSpec {
	readonly include: readonly string[];
	readonly exclude: readonly string[];
}

/** Excludes the wayfinder track, so the two tracks cannot compete for one ticket. */
export const DEFAULT_LABEL_FILTER: LabelFilterSpec = { include: [], exclude: ["wayfinder:*"] };

/**
 * A validated filter. Only `compileLabelFilter` produces one, so a pattern the grammar rejects cannot
 * reach a decision — a malformed pattern that quietly matched nothing is indistinguishable from a
 * filter that found nothing to exclude.
 */
export interface LabelFilter {
	readonly spec: LabelFilterSpec;
	admits(labels: readonly string[]): boolean;
}

/**
 * The whole pattern grammar: a label, matched case-insensitively, optionally ending in `*` to match a
 * prefix. A `*` anywhere else is refused rather than read literally.
 *
 * Case-insensitivity is deliberate and wider than any one tracker's rule: GitHub and GitLab both
 * refuse two labels differing only in case, so folding case cannot merge two distinct labels there,
 * and typing `--exclude Wayfinder:*` against a lowercase label is otherwise a silent miss.
 */
interface Pattern {
	readonly prefix: string;
	readonly whole: boolean;
}

export function compileLabelFilter(spec: LabelFilterSpec): LabelFilter {
	const include = spec.include.map(compilePattern);
	const exclude = spec.exclude.map(compilePattern);
	return {
		spec,
		admits(labels: readonly string[]): boolean {
			const folded = labels.map((label) => label.toLowerCase());
			if (folded.some((label) => matchesAny(label, exclude))) return false;
			return include.length === 0 || folded.some((label) => matchesAny(label, include));
		},
	};
}

function compilePattern(pattern: string): Pattern {
	const trimmed = pattern.trim();
	if (trimmed === "") {
		throw new LabelFilterError("a label pattern cannot be empty");
	}
	const starred = trimmed.endsWith("*");
	const prefix = starred ? trimmed.slice(0, -1) : trimmed;
	if (prefix.includes("*")) {
		throw new LabelFilterError(
			`${pattern} is not a label pattern: a "*" is only a wildcard as the last character, and matches a prefix`,
		);
	}
	if (prefix === "") {
		throw new LabelFilterError(
			'"*" is not a label pattern: omit --include to admit every label, and name what to drop rather than excluding all of them',
		);
	}
	return { prefix: prefix.toLowerCase(), whole: !starred };
}

function matchesAny(label: string, patterns: readonly Pattern[]): boolean {
	return patterns.some((pattern) =>
		pattern.whole ? label === pattern.prefix : label.startsWith(pattern.prefix),
	);
}
