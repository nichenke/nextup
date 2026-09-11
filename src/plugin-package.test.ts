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
 * Narrowed rather than coerced: `String(undefined)` is `"undefined"`, whose `typeof` is `"string"`, so
 * coercing here would let a manifest that had lost its description satisfy the assertion that it has
 * one.
 */
const description = (): string => {
	const value = manifest().description;
	if (typeof value !== "string") throw new Error(`plugin.json description is ${typeof value}, not a string`);
	return value;
};

/**
 * Every line of the command file that names the entry point, trimmed of indentation and of a block
 * quote's `> `.
 *
 * Keyed on the entry point rather than on the markdown around it. Parsing fences was tried and had a
 * hole in every direction: a fence indented under a bullet, a tilde fence, `shell`/`zsh`/`console`
 * info strings, an indented code block with no fence at all, and a fence inside a block quote --
 * each a place a third invocation renders as something a session would run. The grammar is the wrong
 * thing to key on, because a session reads the raw file rather than the rendering.
 *
 * The cost is that this file cannot mention `nextup.ts` in prose without failing the list below, which
 * is the direction to fail in. A fenced sample of the tool's own output is unaffected -- the output
 * names the session command, not this entry point.
 */
const entryPointLines = (markdown: string): string[] =>
	markdown
		.split("\n")
		.map((line) => line.trim().replace(/^>\s*/, ""))
		.filter((line) => line.includes("nextup.ts"));

/** What sits between the first two `---` lines, or null where the file opens without a block. */
const frontmatter = (markdown: string): string | null => {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
	return match === null ? null : match[1]!;
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

	// `:?` rather than a bare expansion. Unset, `bun /bin/nextup.ts` resolves against the nearest
	// package.json rather than the filesystem root, so standing in any checkout it runs that copy at
	// exit 0 and reports a pick from the wrong branch -- measured. `:?` refuses instead, and the quotes
	// carry a path with a space in it.
	test("the command reaches the entry point through the plugin root, and refuses an unset one", () => {
		expect(command()).toContain('"${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts"');
	});

	// Run rather than stat: a file that exists but does not parse is the same broken install as a
	// missing one, and `existsSync` cannot tell them apart.
	test("the entry point the command names runs", () => {
		const help = spawnSync(["bun", join(root, "bin", "nextup.ts"), "--help"]);
		expect(help.stderr.toString()).toBe("");
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("usage: nextup");
	});

	// Asserted as the whole list rather than a flag at a time, so --force on either of these, or a
	// third invocation anywhere in the file, fails here. ADR-0038 has why neither may ship.
	test("the command ships two invocations: a preview that writes nothing and a start that names a ticket", () => {
		expect(entryPointLines(command())).toEqual([
			'bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" --print-command',
			'bun "${CLAUDE_PLUGIN_ROOT:?}/bin/nextup.ts" <ticket> --yes',
		]);
	});

	// Read out of the frontmatter rather than looked for in the file, because deleting the opening `---`
	// leaves both keys as body prose that a substring test still finds -- and takes the description with
	// it. ADR-0038 defers the skill rather than shipping it, which is the decision this line holds.
	test("the command is declared, and is not model-invocable", () => {
		const block = frontmatter(command());
		expect(block).not.toBeNull();
		expect(block).toMatch(/^disable-model-invocation: true$/m);
		expect(block).toMatch(/^description: \S/m);
	});
});

describe("what the plugin claims about itself", () => {
	test("no marketplace of its own: dispatch is the store", () => {
		expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(false);
	});

	test("a command is the only component that ships", () => {
		expect(existsSync(join(root, "skills"))).toBe(false);
		expect(existsSync(join(root, "agents"))).toBe(false);
	});

	test("the description promises no tracker without an adapter", () => {
		expect(description()).toContain("GitHub");
		expect(description()).not.toMatch(/GitLab|Jira/);
	});

	// Word-bounded: `toContain("gh")` is satisfied by "right", and `gh` is the prerequisite most worth
	// naming, since a missing one is caught at the read rather than by a probe.
	test("the description names the prerequisites a person has to have", () => {
		for (const prerequisite of ["bun", "gh", "cmux", "claude"]) {
			expect(description()).toMatch(new RegExp(`\\b${prerequisite}\\b`));
		}
		expect(description()).toContain("/implement");
	});
});
