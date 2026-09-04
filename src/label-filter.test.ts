import { describe, expect, test } from "bun:test";
import { DEFAULT_LABEL_FILTER, LabelFilterError, compileLabelFilter } from "./label-filter";

function admits(spec: { include?: string[]; exclude?: string[] }, labels: string[]): boolean {
	return compileLabelFilter({ include: spec.include ?? [], exclude: spec.exclude ?? [] }).admits(labels);
}

describe("compileLabelFilter", () => {
	test("admits everything when neither list is given", () => {
		expect(admits({}, [])).toBe(true);
		expect(admits({}, ["anything"])).toBe(true);
	});

	test("admits only a ticket carrying one of the included labels", () => {
		expect(admits({ include: ["bug"] }, ["bug", "P1"])).toBe(true);
		expect(admits({ include: ["bug"] }, ["enhancement"])).toBe(false);
		expect(admits({ include: ["bug"] }, [])).toBe(false);
	});

	test("refuses a ticket carrying an excluded label", () => {
		expect(admits({ exclude: ["blocked"] }, ["blocked", "P1"])).toBe(false);
		expect(admits({ exclude: ["blocked"] }, ["P1"])).toBe(true);
	});

	// Otherwise `--include wayfinder:decision --exclude wayfinder:*` would admit the very ticket the
	// exclusion names, and which of the two won would depend on the order they were evaluated in.
	test("lets an exclusion beat an inclusion the same ticket also matches", () => {
		expect(admits({ include: ["P1"], exclude: ["wayfinder:*"] }, ["P1", "wayfinder:decision"])).toBe(false);
	});

	test("matches a trailing star as a prefix", () => {
		expect(admits({ exclude: ["wayfinder:*"] }, ["wayfinder:decision"])).toBe(false);
		expect(admits({ exclude: ["wayfinder:*"] }, ["wayfinder:"])).toBe(false);
		expect(admits({ exclude: ["wayfinder:*"] }, ["wayfinding"])).toBe(true);
	});

	test("matches a label whatever its casing", () => {
		expect(admits({ exclude: ["Wayfinder:*"] }, ["wayfinder:decision"])).toBe(false);
		expect(admits({ include: ["p1"] }, ["P1"])).toBe(true);
	});

	// A star anywhere but the end is refused rather than read as a literal: a pattern that silently
	// matches nothing looks exactly like a filter that found nothing to exclude.
	test("refuses a star that is not the last character", () => {
		expect(() => admits({ exclude: ["way*er"] }, [])).toThrow(LabelFilterError);
		expect(() => admits({ exclude: ["*finder"] }, [])).toThrow(LabelFilterError);
		expect(() => admits({ exclude: ["a*b*"] }, [])).toThrow(LabelFilterError);
	});

	test("refuses a bare star, whose two readings both have a clearer spelling", () => {
		expect(() => admits({ include: ["*"] }, [])).toThrow(LabelFilterError);
		expect(() => admits({ exclude: ["*"] }, [])).toThrow(LabelFilterError);
	});

	test("refuses an empty pattern", () => {
		expect(() => admits({ exclude: [""] }, [])).toThrow(LabelFilterError);
		expect(() => admits({ exclude: ["   "] }, [])).toThrow(LabelFilterError);
	});

	test("carries its spec, so output can say which filter ran", () => {
		const filter = compileLabelFilter({ include: ["bug"], exclude: ["wayfinder:*"] });
		expect(filter.spec).toEqual({ include: ["bug"], exclude: ["wayfinder:*"] });
	});
});

describe("DEFAULT_LABEL_FILTER", () => {
	test("excludes the wayfinder track and includes everything else", () => {
		const filter = compileLabelFilter(DEFAULT_LABEL_FILTER);
		expect(filter.admits(["wayfinder:decision"])).toBe(false);
		expect(filter.admits(["ready-for-agent"])).toBe(true);
		expect(filter.admits([])).toBe(true);
	});
});
