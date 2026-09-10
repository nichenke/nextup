/** A list with at least one member. */
export type NonEmpty<T> = readonly [T, ...T[]];

/** Head and tail apart, because `Array.map` widens a non-empty list back to one that may be empty. */
export function mapNonEmpty<T, U>(list: NonEmpty<T>, transform: (value: T) => U): NonEmpty<U> {
	const [first, ...rest] = list;
	return [transform(first), ...rest.map(transform)];
}
