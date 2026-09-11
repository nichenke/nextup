import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

/**
 * The manifest shape Claude Code reads. Only the fields this suite asserts on are named; a manifest
 * carrying more is still valid.
 */
type PluginManifest = { name?: unknown; version?: unknown; description?: unknown };

const manifest = (): PluginManifest => JSON.parse(read(".claude-plugin", "plugin.json")) as PluginManifest;

describe("the repository ships an invokable plugin", () => {
	test("plugin.json parses and names the plugin", () => {
		const { name, version, description } = manifest();
		expect(name).toBe("nextup");
		expect(typeof version).toBe("string");
		expect(typeof description).toBe("string");
	});

	test("the command file is where Claude Code discovers commands", () => {
		expect(existsSync(join(root, "commands", "nextup.md"))).toBe(true);
	});

	test("the command reaches the entry point through the plugin root", () => {
		expect(read("commands", "nextup.md")).toContain("${CLAUDE_PLUGIN_ROOT}/bin/nextup.ts");
	});

	test("the entry point the command names exists", () => {
		expect(existsSync(join(root, "bin", "nextup.ts"))).toBe(true);
	});
});

/**
 * Every line inside a fenced code block, in file order. Fences are what a session runs, so this is
 * what the invocation list below is asserted over.
 *
 * Keyed on the fence rather than on the command's own spelling: matching `bun ${CLAUDE_PLUGIN_ROOT}/...`
 * would miss a third invocation written any other way -- `bun bin/nextup.ts --force`, or the path with
 * no `bun` ahead of it -- while matching that same text in a prose sentence. An invocation written in
 * prose backticks rather than a fence is outside what this sees.
 */
const fencedLines = (markdown: string): string[] =>
	markdown.split("\n").reduce<{ inside: boolean; lines: string[] }>(
		(state, line) =>
			line.startsWith("```")
				? { ...state, inside: !state.inside }
				: state.inside
					? { ...state, lines: [...state.lines, line] }
					: state,
		{ inside: false, lines: [] },
	).lines;

describe("the repository ships an invokable plugin", () => {
	// Asserted as the whole list rather than a flag at a time, so --force on either of these, or a
	// third invocation in any spelling, fails here. ADR-0038 has why neither may ship.
	test("the command ships two invocations: a preview that writes nothing and a start that names a ticket", () => {
		expect(fencedLines(read("commands", "nextup.md"))).toEqual([
			"bun ${CLAUDE_PLUGIN_ROOT}/bin/nextup.ts --print-command",
			"bun ${CLAUDE_PLUGIN_ROOT}/bin/nextup.ts <ticket> --yes",
		]);
	});
});

describe("what the plugin claims about itself", () => {
	test("no marketplace of its own: dispatch is the store", () => {
		expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(false);
	});

	test("the description promises no tracker without an adapter", () => {
		const description = String(manifest().description);
		expect(description).toContain("GitHub");
		expect(description).not.toMatch(/GitLab|Jira/);
	});

	test("the description names the prerequisites a person has to have", () => {
		const description = String(manifest().description);
		for (const prerequisite of ["bun", "gh", "cmux", "/implement"]) {
			expect(description).toContain(prerequisite);
		}
	});
});
