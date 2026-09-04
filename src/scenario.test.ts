import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScenarioError, loadScenario } from "./scenario";
import { selectionJson } from "./selection-output";
import { select } from "./selector";

const SCENARIOS = join(dirname(import.meta.dir), "fixtures", "scenarios");
const INPUT = ".input.json";
const EXPECTED = ".expected.json";

/**
 * Rewrites every expected file from what the selector currently answers; see README's "Fixing a bad
 * pick". Ignored under `CI`, where a rewrite would make the suite assert whatever the code does and
 * report that as a pass — the one failure mode a golden suite exists to prevent. Left exported in a
 * shell it does the same thing locally, which is why the guard is here rather than in the README.
 */
const UPDATING = process.env.UPDATE_SCENARIOS === "1" && process.env.CI === undefined;

function scenarioNames(): string[] {
	return readdirSync(SCENARIOS)
		.filter((name) => name.endsWith(INPUT))
		.map((name) => name.slice(0, -INPUT.length))
		.sort();
}

describe("the golden-file scenario suite", () => {
	const names = scenarioNames();

	test("holds at least one scenario", () => {
		expect(names.length).toBeGreaterThan(0);
	});

	// Only inputs are enumerated, so a renamed or deleted one leaves its expected file behind and drops
	// that scenario from the suite with nothing failing.
	test("pairs every expected file with an input", () => {
		const expected = readdirSync(SCENARIOS)
			.filter((name) => name.endsWith(EXPECTED))
			.map((name) => name.slice(0, -EXPECTED.length))
			.sort();
		expect(expected).toEqual(names);
	});

	for (const name of names) {
		test(name, () => {
			const scenario = loadScenario(join(SCENARIOS, `${name}${INPUT}`));
			expect(scenario.description).not.toBe("");

			const answer = selectionJson(select(scenario.input));
			const expectedPath = join(SCENARIOS, `${name}${EXPECTED}`);
			if (UPDATING) {
				writeFileSync(expectedPath, `${JSON.stringify(answer, null, "\t")}\n`);
			}
			expect(answer).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
		});
	}
});

describe("loadScenario", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function scenarioFile(body: unknown): string {
		const root = mkdtempSync(join(tmpdir(), "nextup-scenario-"));
		roots.push(root);
		const path = join(root, "one.input.json");
		writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
		return path;
	}

	const ONE_TICKET = {
		description: "one open ticket",
		truncated: false,
		tickets: [{ ref: "md:1", title: "First", state: "open", blockers: [] }],
	};

	test("reads a ticket set and the filter applied to it", () => {
		const scenario = loadScenario(scenarioFile({ ...ONE_TICKET, filter: { exclude: ["wayfinder:*"] } }));
		expect(scenario.input.tickets).toHaveLength(1);
		expect(scenario.input.filter.spec).toEqual({ include: [], exclude: ["wayfinder:*"] });
		expect(scenario.input.truncated).toBe(false);
	});

	test("refuses an unrecognised key", () => {
		expect(() => loadScenario(scenarioFile({ ...ONE_TICKET, filtr: {} }))).toThrow(ScenarioError);
		expect(() =>
			loadScenario(scenarioFile({ ...ONE_TICKET, tickets: [{ ...ONE_TICKET.tickets[0], lables: [] }] })),
		).toThrow(ScenarioError);
	});

	test("refuses a ticket that does not state its blockers", () => {
		expect(() => loadScenario(scenarioFile({ ...ONE_TICKET, tickets: [{ ref: "md:1", title: "First", state: "open" }] }))).toThrow(
			ScenarioError,
		);
	});

	test("refuses a reference that would resolve against the surrounding checkout", () => {
		expect(() =>
			loadScenario(scenarioFile({ ...ONE_TICKET, tickets: [{ ref: "gh:1", title: "First", state: "open", blockers: [] }] })),
		).toThrow(ScenarioError);
	});

	test("refuses a file that is not JSON, naming the file", () => {
		expect(() => loadScenario(scenarioFile("{"))).toThrow(ScenarioError);
	});

	test("refuses a missing file rather than reporting an errno", () => {
		expect(() => loadScenario(join(SCENARIOS, "no-such-scenario.input.json"))).toThrow(ScenarioError);
	});

	test("keeps unknown blocking apart from an empty blocker list", () => {
		const unknown = loadScenario(
			scenarioFile({ ...ONE_TICKET, tickets: [{ ref: "md:1", title: "First", state: "open", blockers: "unknown" }] }),
		);
		expect(unknown.input.tickets[0]!.blockers).toBe("unknown");
	});
});
