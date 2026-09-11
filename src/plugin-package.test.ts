import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");
const command = (): string => read("commands", "nextup.md");

/**
 * The three manifest fields this suite asserts on. A manifest carrying more is still valid, and these
 * are `unknown` rather than `string` because `JSON.parse` of a file on disk promises neither.
 */
type PluginManifest = { name?: unknown; version?: unknown; description?: unknown };

const manifest = (): PluginManifest => JSON.parse(read(".claude-plugin", "plugin.json")) as PluginManifest;

/**
 * The manifest's description, or a failure naming what was there instead.
 *
 * Narrowed rather than coerced: `String(undefined)` is `"undefined"`, which satisfies the negative
 * assertion below — so a manifest that had lost its description would report "promises no unwired
 * tracker" while promising nothing at all.
 */
const description = (): string => {
	const value = manifest().description;
	if (typeof value !== "string") throw new Error(`plugin.json description is ${typeof value}, not a string`);
	return value;
};

/**
 * Every line inside a shell fence, in file order.
 *
 * Keyed on the fence rather than on the command's own spelling, because matching
 * `bun ${CLAUDE_PLUGIN_ROOT}/...` would both miss a third invocation written another way --
 * `bun bin/nextup.ts --force`, or the path with no `bun` ahead of it -- and fire on that same text in
 * a prose sentence.
 *
 * Every part of the fence grammar an invocation could hide behind: any leading indentation, `~` as
 * well as backticks, and a closing fence that must use the opening character and be at least as long.
 * Indentation is unbounded rather than CommonMark's three spaces, because a fence indented four under
 * a list bullet is still a fence there -- and an escape-hatch invocation under a bullet is how a third
 * one would actually get written. Only `sh` and `bash` fences are collected, so a fenced sample of the
 * tool's own output can be added without touching the invocation list.
 *
 * Two shapes are outside what this sees, and neither is a line a session would run: an invocation in
 * prose backticks, and one nested inside a longer fence that is not itself shell.
 */
const shellLines = (markdown: string): string[] => {
	const lines: string[] = [];
	let fence: { char: string; length: number; shell: boolean } | null = null;
	for (const line of markdown.split("\n")) {
		const open = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
		if (fence === null) {
			if (open !== null) fence = { char: open[1]![0]!, length: open[1]!.length, shell: /^(sh|bash)?$/.test(open[2]!) };
			continue;
		}
		const closes = open !== null && open[1]![0] === fence.char && open[1]!.length >= fence.length && open[2] === "";
		if (closes) fence = null;
		else if (fence.shell) lines.push(line);
	}
	return lines;
};

describe("the repository ships an invokable plugin", () => {
	test("plugin.json parses and names the plugin", () => {
		const { name, version } = manifest();
		expect(name).toBe("nextup");
		expect(typeof version).toBe("string");
		expect(typeof description()).toBe("string");
	});

	test("the command file is where Claude Code discovers commands", () => {
		expect(existsSync(join(root, "commands", "nextup.md"))).toBe(true);
	});

	test("the command reaches the entry point through the plugin root", () => {
		expect(command()).toContain("${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts");
	});

	// Run rather than stat: a file that exists but does not parse is the same broken install as a
	// missing one, and `existsSync` cannot tell them apart.
	test("the entry point the command names runs", () => {
		const help = spawnSync(["bun", join(root, "bin", "nextup.ts"), "--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("usage: nextup");
	});

	// Asserted as the whole list rather than a flag at a time, so --force on either of these, or a
	// third invocation in any spelling a shell fence can carry, fails here. ADR-0038 has why neither
	// may ship.
	test("the command ships two invocations: a preview that writes nothing and a start that names a ticket", () => {
		expect(shellLines(command())).toEqual([
			'bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" --print-command',
			'bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" <ticket> --yes',
		]);
	});

	// The one line standing between a person typing six characters and a session deciding by itself to
	// claim somebody's ticket. ADR-0038 leaves that decision open on purpose, so it is held by a test
	// rather than by whoever next reformats the frontmatter.
	test("the command is not model-invocable", () => {
		expect(command()).toContain("\ndisable-model-invocation: true\n");
	});
});

describe("what the plugin claims about itself", () => {
	test("no marketplace of its own: dispatch is the store", () => {
		expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(false);
	});

	// The ADR's opening names all three together, because a plugin shipping none of them is what this
	// change was for. A skill in particular is the decision the command's frontmatter defers.
	test("a command is the only component that ships", () => {
		expect(existsSync(join(root, "skills"))).toBe(false);
		expect(existsSync(join(root, "agents"))).toBe(false);
	});

	test("the description promises no tracker without an adapter", () => {
		expect(description()).toContain("GitHub");
		expect(description()).not.toMatch(/GitLab|Jira/);
	});

	test("the description names the prerequisites a person has to have", () => {
		for (const prerequisite of ["bun", "gh", "cmux", "claude", "/implement"]) {
			expect(description()).toContain(prerequisite);
		}
	});
});
