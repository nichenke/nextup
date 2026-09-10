/**
 * A list with at least one member. Here rather than beside its first consumer, because nothing about the
 * shape belongs to one: a module needing it would otherwise import the feature module that happened to want
 * it first, or hand-roll the tuple again — `Argv` in `command-builders.ts` is that shape written out.
 */
export type NonEmpty<T> = readonly [T, ...T[]];

/** Head and tail apart, because `Array.map` widens a non-empty list back to one that may be empty. */
export function mapNonEmpty<T, U>(list: NonEmpty<T>, transform: (value: T) => U): NonEmpty<U> {
	const [first, ...rest] = list;
	return [transform(first), ...rest.map(transform)];
}
