import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SLASH_COMMAND, formatCommand, sessionCommand } from "./command-builders";
import type { TicketRef } from "./ticket-ref";

const GOLDENS = join(dirname(import.meta.dir), "fixtures", "commands");
const SUFFIX = ".expected.json";

const UPDATING = process.env.UPDATE_COMMANDS === "1" && process.env.CI === undefined;

interface Case {
	readonly name: string;
	readonly description: string;
	readonly input: Parameters<typeof sessionCommand>[0];
}

const markdown: TicketRef = { tracker: "markdown", repo: null, host: null, key: "1" };
const github: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "1" };
const jira: TicketRef = { tracker: "jira", repo: null, host: null, key: "ABC-7" };

const CASES: readonly Case[] = [
	{
		name: "session-on-a-markdown-ticket",
		description: "The v1 substrate: a local markdown ticket, which carries neither a repository nor a host.",
		input: { ref: markdown, slashCommand: DEFAULT_SLASH_COMMAND },
	},
	{
		name: "session-on-a-repo-scoped-ticket",
		description: "A tracker whose reference carries a repository, so the short form the session receives holds one.",
		input: { ref: github, slashCommand: DEFAULT_SLASH_COMMAND },
	},
	{
		name: "session-on-a-keyed-ticket",
		description: "A tracker keyed by a project prefix rather than a number, standing in for Jira.",
		input: { ref: jira, slashCommand: DEFAULT_SLASH_COMMAND },
	},
	{
		name: "session-on-a-named-slash-command",
		description: "A slash command other than the default, which ticket 09 exposes as a flag.",
		input: { ref: markdown, slashCommand: "/triage" },
	},
];

describe("the command-builder golden files", () => {
	// Declared rather than discovered, so deleting a golden drops its case loudly instead of silently.
	test("holds a golden for exactly the declared cases", () => {
		mkdirSync(GOLDENS, { recursive: true });
		const found = readdirSync(GOLDENS)
			.filter((entry) => entry.endsWith(SUFFIX))
			.map((entry) => entry.slice(0, -SUFFIX.length))
			.sort();
		expect(found).toEqual([...CASES.map((one) => one.name)].sort());
	});

	for (const one of CASES) {
		test(one.name, () => {
			const golden = { description: one.description, input: one.input, argv: sessionCommand(one.input) };
			const path = join(GOLDENS, `${one.name}${SUFFIX}`);
			if (UPDATING) writeFileSync(path, `${JSON.stringify(golden, null, "\t")}\n`);
			expect(golden).toEqual(JSON.parse(readFileSync(path, "utf8")));
		});
	}
});

describe("sessionCommand", () => {
	test("hands the session the ticket reference as one argument, and nothing else about the pick", () => {
		const argv = sessionCommand({ ref: markdown, slashCommand: DEFAULT_SLASH_COMMAND });
		expect(argv).toEqual(["claude", "/implement md:1"]);
	});

	test("refuses a slash command that is not one, rather than emitting an argument the session reads as a prompt", () => {
		expect(() => sessionCommand({ ref: markdown, slashCommand: "implement" })).toThrow(/slash command/);
	});

	test("refuses a slash command carrying a space, which would make the reference a separate word", () => {
		expect(() => sessionCommand({ ref: markdown, slashCommand: "/implement now" })).toThrow(/slash command/);
	});
});

describe("formatCommand", () => {
	test("renders argv as a line a shell would parse back into the same words", () => {
		expect(formatCommand(["claude", "/implement md:1"])).toBe("claude '/implement md:1'");
	});

	test("leaves a word needing no quoting unquoted", () => {
		expect(formatCommand(["git", "status"])).toBe("git status");
	});

	test("escapes a single quote rather than ending the quoting at it", () => {
		expect(formatCommand(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
	});
});
