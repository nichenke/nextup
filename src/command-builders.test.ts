import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_SLASH_COMMAND,
	authStatusCommand,
	formatCommand,
	jiraIdentityCommand,
	originRemoteCommand,
	sessionCommand,
} from "./command-builders";
import type { TicketRef } from "./ticket-ref";

const GOLDENS = join(dirname(import.meta.dir), "fixtures", "commands");
const SUFFIX = ".expected.json";

const UPDATING = process.env.UPDATE_COMMANDS === "1" && process.env.CI === undefined;

interface Case {
	readonly name: string;
	readonly description: string;
	/** What the builder was called with, written into the golden so the argv has its cause beside it. */
	readonly input: unknown;
	readonly build: () => readonly string[];
}

const markdown: TicketRef = { tracker: "markdown", repo: null, host: null, key: "1" };
const github: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "1" };
const jira: TicketRef = { tracker: "jira", repo: null, host: null, key: "ABC-7" };

const CASES: readonly Case[] = [
	{
		name: "session-on-a-markdown-ticket",
		description: "The v1 substrate: a local markdown ticket, which carries neither a repository nor a host.",
		input: { ref: markdown, slashCommand: DEFAULT_SLASH_COMMAND },
		build: () => sessionCommand({ ref: markdown, slashCommand: DEFAULT_SLASH_COMMAND }),
	},
	{
		name: "session-on-a-repo-scoped-ticket",
		description: "A tracker whose reference carries a repository, so the short form the session receives holds one.",
		input: { ref: github, slashCommand: DEFAULT_SLASH_COMMAND },
		build: () => sessionCommand({ ref: github, slashCommand: DEFAULT_SLASH_COMMAND }),
	},
	{
		name: "session-on-a-keyed-ticket",
		description: "A tracker keyed by a project prefix rather than a number, standing in for Jira.",
		input: { ref: jira, slashCommand: DEFAULT_SLASH_COMMAND },
		build: () => sessionCommand({ ref: jira, slashCommand: DEFAULT_SLASH_COMMAND }),
	},
	{
		name: "session-on-a-named-slash-command",
		description: "A slash command other than the default, which ticket 09 exposes as a flag.",
		input: { ref: markdown, slashCommand: "/triage" },
		build: () => sessionCommand({ ref: markdown, slashCommand: "/triage" }),
	},
	{
		name: "github-auth-status",
		description: "Asking the GitHub CLI whether the account it would use is authenticated to a host.",
		input: { tracker: "github", hostname: "example.test" },
		build: () => authStatusCommand("github", "example.test"),
	},
	{
		name: "gitlab-auth-status",
		description: "The same question of the GitLab CLI, which has no second account to narrow to.",
		input: { tracker: "gitlab", hostname: "example.test" },
		build: () => authStatusCommand("gitlab", "example.test"),
	},
	{
		name: "jira-identity",
		description: "Whether a Jira session exists at all, since its config holds no host worth comparing.",
		input: {},
		build: () => jiraIdentityCommand(),
	},
	{
		name: "origin-remote",
		description: "The remote a repository-scoped short form is resolved against.",
		input: {},
		build: () => originRemoteCommand(),
	},
];

describe("the command-builder golden files", () => {
	// Declared rather than discovered by listing the directory; README's "The command contract" says why.
	// Skipped while regenerating, where a case declared but not yet written would fail before its own
	// test had the chance to write it.
	test.skipIf(UPDATING)("holds a golden for exactly the declared cases", () => {
		const found = readdirSync(GOLDENS)
			.filter((entry) => entry.endsWith(SUFFIX))
			.map((entry) => entry.slice(0, -SUFFIX.length))
			.sort();
		expect(found).toEqual([...CASES.map((one) => one.name)].sort());
	});

	for (const one of CASES) {
		test(one.name, () => {
			const golden = { description: one.description, input: one.input, argv: one.build() };
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

describe("authStatusCommand", () => {
	test("narrows the GitHub question to the active account, and asks GitLab plainly", () => {
		expect(authStatusCommand("github", "example.test")).toContain("--active");
		expect(authStatusCommand("gitlab", "example.test")).not.toContain("--active");
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

	test("quotes a leading word a shell would read as an assignment rather than a command", () => {
		expect(formatCommand(["a=b", "--flag=value"])).toBe("'a=b' --flag=value");
	});
});
