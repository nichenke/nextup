import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const adrDir = join(import.meta.dir, "..", "docs", "adr");

/**
 * Every ADR filename that does not read as `NNNN-<slug>.md`, and every number carried by more than one
 * file. Two faults from one pass because they share a cause: a number is read off the filename, so a
 * name the pattern cannot read has no number to compare and would otherwise leave the directory
 * half-checked.
 *
 * Exactly four digits, anchored. A five-digit prefix is a malformed name rather than a number in the
 * thousands — accepting it would let `00411` and `0041` sort as neighbours and read as unrelated.
 *
 * Gaps are not a fault. This repository has none at 0014 or 0015 and both are deliberate: a number is
 * spent when an ADR is drafted, and one that never lands leaves a hole rather than a renumbering.
 */
function adrNumberFaults(filenames: readonly string[]): {
	readonly malformed: readonly string[];
	readonly duplicated: readonly { readonly number: string; readonly files: readonly string[] }[];
} {
	const malformed: string[] = [];
	const byNumber = new Map<string, string[]>();
	for (const filename of filenames) {
		const match = /^(\d{4})-.+\.md$/.exec(filename);
		if (match === null) {
			malformed.push(filename);
			continue;
		}
		const number = match[1]!;
		byNumber.set(number, [...(byNumber.get(number) ?? []), filename]);
	}
	const duplicated = [...byNumber.entries()]
		.filter(([, files]) => files.length > 1)
		.map(([number, files]) => ({ number, files: [...files].sort() }))
		.sort((a, b) => a.number.localeCompare(b.number));
	return { malformed: malformed.sort(), duplicated };
}

describe("ADR numbers are unique", () => {
	test("the checked-in ADRs carry one number each", () => {
		const faults = adrNumberFaults(readdirSync(adrDir));
		expect(faults.duplicated).toEqual([]);
		expect(faults.malformed).toEqual([]);
	});

	test("two ADRs on one number are named, with the files that collided", () => {
		const faults = adrNumberFaults(["0041-first-one.md", "0041-second-one.md", "0040-alone.md"]);
		expect(faults.duplicated).toEqual([{ number: "0041", files: ["0041-first-one.md", "0041-second-one.md"] }]);
	});

	test("a gap in the sequence is not a fault", () => {
		expect(adrNumberFaults(["0013-a.md", "0016-b.md"])).toEqual({ malformed: [], duplicated: [] });
	});

	test("a name the pattern cannot read is reported rather than skipped", () => {
		// Each of these once looked like a number to a laxer pattern: an unnumbered note, a short
		// prefix, a long one, a slugless name, and a number carried by something that is not markdown.
		const faults = adrNumberFaults(["README.md", "041-short.md", "00411-long.md", "0042.md", "0043-x.txt"]);
		expect(faults.malformed).toEqual(["00411-long.md", "0042.md", "0043-x.txt", "041-short.md", "README.md"]);
		expect(faults.duplicated).toEqual([]);
	});

	test("an empty directory is not a fault", () => {
		expect(adrNumberFaults([])).toEqual({ malformed: [], duplicated: [] });
	});

	test("three files on one number are all named, not just the first pair", () => {
		const [collision] = adrNumberFaults(["0007-c.md", "0007-a.md", "0007-b.md"]).duplicated;
		expect(collision?.files).toEqual(["0007-a.md", "0007-b.md", "0007-c.md"]);
	});
});
