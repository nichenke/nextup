import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScenarioError, loadScenario } from "./scenario";
import { renderSelection, selectionJson } from "./selection-output";
import { select } from "./selector";

const SCENARIOS = join(dirname(import.meta.dir), "fixtures", "scenarios");
const INPUT = ".input.json";
const EXPECTED = ".expected.json";
const RENDERED = ".expected.txt";

/**
 * Rewrites every expected file from what the selector currently answers; see README's "Fixing a bad
 * pick". Ignored under `CI`, where a rewrite would make the suite assert whatever the code does and
 * report that as a pass — the one failure mode a golden suite exists to prevent.
 */
const UPDATING = process.env.UPDATE_SCENARIOS === "1" && process.env.CI === undefined;

/** The scenarios whose human rendering is pinned as well as their JSON. */
const RENDERED_SCENARIOS = ["lone-pick-beside-blocked-candidates", "unknown-consulted-when-nothing-confirmed"];

describe("the golden-file scenario suite", () => {
	const names = namesEndingIn(INPUT);

	test("holds at least one scenario", () => {
		expect(names.length).toBeGreaterThan(0);
	});

	// Only inputs are enumerated, so a renamed or deleted one leaves its expected file behind and drops
	// that scenario from the suite with nothing failing.
	test("pairs every expected file with an input", () => {
		expect(namesEndingIn(EXPECTED)).toEqual(names);
	});

	// Declared rather than discovered by looking for the files: deleting a rendering golden would
	// otherwise drop its assertion with nothing failing, which is the same silent gap an orphaned
	// expected file is refused for.
	test("holds a rendering golden for exactly the scenarios that name one", () => {
		expect(namesEndingIn(RENDERED)).toEqual([...RENDERED_SCENARIOS].sort());
		expect(names).toEqual(expect.arrayContaining(RENDERED_SCENARIOS));
	});

	for (const name of names) {
		test(name, () => {
			const scenario = loadScenario(join(SCENARIOS, `${name}${INPUT}`));
			expect(scenario.description).not.toBe("");

			const selection = select(scenario.input);
			const answer = selectionJson(selection);
			const expectedPath = join(SCENARIOS, `${name}${EXPECTED}`);
			if (UPDATING) {
				writeFileSync(expectedPath, `${JSON.stringify(answer, null, "\t")}\n`);
			}
			expect(answer).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));

			// Only the scenarios named in RENDERED_SCENARIOS; README's "Fixing a bad pick" says why.
			if (!RENDERED_SCENARIOS.includes(name)) return;
			const renderedPath = join(SCENARIOS, `${name}${RENDERED}`);
			const rendered = renderSelection(selection);
			if (UPDATING) writeFileSync(renderedPath, rendered);
			expect(rendered).toBe(readFileSync(renderedPath, "utf8"));
		});
	}
});

function namesEndingIn(suffix: string): string[] {
	return readdirSync(SCENARIOS)
		.filter((name) => name.endsWith(suffix))
		.map((name) => name.slice(0, -suffix.length))
		.sort();
}

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
