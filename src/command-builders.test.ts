import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_SLASH_COMMAND,
	GITHUB_TICKET_FIELDS,
	authStatusCommand,
	refExistsCommand,
	defaultBranchCommand,
	formatCommand,
	gitCommonDirCommand,
	githubClaimCommand,
	githubIssueListCommand,
	githubIssueViewCommand,
	jiraIdentityCommand,
	originRemoteCommand,
	remoteBranchesCommand,
	sessionBinaryAliveCommand,
	sessionCommand,
	workspaceCommand,
	workspaceHostAliveCommand,
	worktreeAddCommand,
	worktreeIdentityCommand,
	worktreeListCommand,
	withoutBlockingField,
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

const github: TicketRef = { tracker: "github", repo: "example/repo", key: "1" };
const jira: TicketRef = { tracker: "jira", host: null, key: "ABC-7" };

const BRANCH = "feature/reader-8";
const WORKTREE_PATH = "/repo/.worktrees/reader-8";
const SESSION = sessionCommand({ ref: github, slashCommand: DEFAULT_SLASH_COMMAND });

const CASES: readonly Case[] = [
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
		description: "A slash command other than the default.",
		input: { ref: github, slashCommand: "/triage" },
		build: () => sessionCommand({ ref: github, slashCommand: "/triage" }),
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
	{
		name: "worktree-list",
		description: "Every worktree the repository has registered, which is what the worktree step reads first.",
		input: { repo: "/repo" },
		build: () => worktreeListCommand("/repo"),
	},
	{
		name: "ref-exists",
		description: "Whether one fully-qualified ref is there, asked of a local branch and of the target origin/HEAD names.",
		input: { repo: "/repo", ref: `refs/heads/${BRANCH}` },
		build: () => refExistsCommand("/repo", `refs/heads/${BRANCH}`),
	},
	{
		name: "remote-branches",
		description: "Which remotes have the branch, asked when the repository does not: origin's tip is adopted, and two remotes are ambiguous to git.",
		input: { repo: "/repo", branch: BRANCH },
		build: () => remoteBranchesCommand("/repo", BRANCH),
	},
	{
		name: "git-common-dir",
		description: "Where the repository keeps its administration, so a layout this does not work in can be refused.",
		input: { repo: "/repo" },
		build: () => gitCommonDirCommand("/repo"),
	},
	{
		name: "default-branch",
		description: "The branch the primary checkout is warned about drifting off.",
		input: { repo: "/repo" },
		build: () => defaultBranchCommand("/repo"),
	},
	{
		name: "worktree-identity",
		description: "What a directory is, asked of git inside it: its own root, its repository, its branch — the listing can be wrong where this cannot.",
		input: { path: WORKTREE_PATH },
		build: () => worktreeIdentityCommand(WORKTREE_PATH),
	},
	{
		name: "worktree-add-new-branch",
		description: "A worktree for a branch that does not exist yet, cut from the primary checkout's HEAD.",
		input: { repo: "/repo", path: WORKTREE_PATH, branch: BRANCH, create: true },
		build: () => worktreeAddCommand("/repo", WORKTREE_PATH, BRANCH, true),
	},
	{
		name: "worktree-add-existing-branch",
		description: "A worktree for a branch that already exists, where -b would be a fatal error instead.",
		input: { repo: "/repo", path: WORKTREE_PATH, branch: BRANCH, create: false },
		build: () => worktreeAddCommand("/repo", WORKTREE_PATH, BRANCH, false),
	},
	{
		name: "github-issue-list",
		description: "One read of a GitHub ticket set, asking for one row more than the adapter's limit.",
		input: { repo: "example/repo", rows: 31 },
		build: () => githubIssueListCommand({ repo: "example/repo", rows: 31 }),
	},
	{
		name: "github-issue-view",
		description: "One read of a single named GitHub ticket, asking the projection the set read asks for.",
		input: { repo: "example/repo", key: "1" },
		build: () => githubIssueViewCommand({ repo: "example/repo", key: "1" }),
	},
	{
		name: "github-claim",
		description: "The one write that claims a GitHub ticket, assigning whoever the CLI is authenticated as.",
		input: { repo: "example/repo", key: "1" },
		build: () => githubClaimCommand({ repo: "example/repo", key: "1" }),
	},
	{
		name: "session-binary-alive",
		description: "Whether the binary a session is started with will run, asked before anything is written.",
		input: {},
		build: () => sessionBinaryAliveCommand(),
	},
	{
		name: "workspace-host-alive",
		description: "Whether the workspace host is running.",
		input: {},
		build: () => workspaceHostAliveCommand(),
	},
	{
		name: "workspace",
		description: "The workspace that runs one session in one worktree, its session argv rendered as a shell line.",
		input: { name: "reader-8", cwd: WORKTREE_PATH, command: SESSION },
		build: () => workspaceCommand({ name: "reader-8", cwd: WORKTREE_PATH, command: SESSION }),
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
		const argv = sessionCommand({ ref: github, slashCommand: DEFAULT_SLASH_COMMAND });
		expect(argv).toEqual(["claude", "/implement gh:example/repo#1"]);
	});

	test("refuses a slash command that is not one, rather than emitting an argument the session reads as a prompt", () => {
		expect(() => sessionCommand({ ref: github, slashCommand: "implement" })).toThrow(/slash command/);
	});

	test("refuses a slash command carrying a space, which would make the reference a separate word", () => {
		expect(() => sessionCommand({ ref: github, slashCommand: "/implement now" })).toThrow(/slash command/);
	});
});

describe("authStatusCommand", () => {
	test("narrows the GitHub question to the active account, and asks GitLab plainly", () => {
		expect(authStatusCommand("github", "example.test")).toContain("--active");
		expect(authStatusCommand("gitlab", "example.test")).not.toContain("--active");
	});
});

describe("githubIssueListCommand", () => {
	test("reads open tickets only, so the row limit is spent on tickets a pick can come from", () => {
		const argv = githubIssueListCommand({ repo: "example/repo", rows: 2 });
		expect(argv[argv.indexOf("--state") + 1]).toBe("open");
	});

	test("refuses a row count no read could use, rather than letting the CLI reject it", () => {
		expect(() => githubIssueListCommand({ repo: "example/repo", rows: 0 })).toThrow(/above zero/);
		expect(() => githubIssueListCommand({ repo: "example/repo", rows: 1.5 })).toThrow(/whole number/);
	});
});

describe("withoutBlockingField", () => {
	test("drops the blocking field and leaves the rest of the projection alone", () => {
		const argv = withoutBlockingField(githubIssueListCommand({ repo: "example/repo", rows: 2 }));
		const projection = argv[argv.indexOf("--json") + 1]!.split(",");
		expect(projection).not.toContain("blockedBy");
		expect(projection).toEqual(GITHUB_TICKET_FIELDS.filter((field) => field !== "blockedBy"));
	});

	test("changes nothing else about the read", () => {
		const asked = githubIssueListCommand({ repo: "example/repo", rows: 2 });
		const blinded = withoutBlockingField(asked);
		expect(blinded.length).toBe(asked.length);
		expect(blinded.filter((word, index) => word !== asked[index])).toHaveLength(1);
	});

	test("refuses an argv that does not spell its projection as one word", () => {
		expect(() => withoutBlockingField(["gh", "issue", "list", "--json", "number", "--json", "blockedBy"])).toThrow(
			/does not spell the issue-list projection/,
		);
	});
});

describe("githubIssueViewCommand", () => {
	test("asks the projection the set read asks for, so one row reader parses both", () => {
		const argv = githubIssueViewCommand({ repo: "example/repo", key: "7" });
		expect(argv[argv.indexOf("--json") + 1]).toBe(GITHUB_TICKET_FIELDS.join(","));
	});

	test("names the issue after a separator, so no spelling of a key is read as a flag", () => {
		const argv = githubIssueViewCommand({ repo: "example/repo", key: "7" });
		expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "7"]);
	});

	test("refuses a key the CLI would resolve to a different issue, or read as a flag", () => {
		expect(() => githubIssueViewCommand({ repo: "example/repo", key: "012" })).toThrow(/canonical/);
		expect(() => githubIssueViewCommand({ repo: "example/repo", key: "0" })).toThrow(/canonical/);
		expect(() => githubIssueViewCommand({ repo: "example/repo", key: "-h" })).toThrow(/issue number/);
		expect(() => githubIssueViewCommand({ repo: "example/repo", key: "ABC-7" })).toThrow(/issue number/);
	});
});

describe("githubClaimCommand", () => {
	test("names the authenticated account rather than a login, so the write is the only call", () => {
		const argv = githubClaimCommand({ repo: "example/repo", key: "7" });
		expect(argv[argv.indexOf("--add-assignee") + 1]).toBe("@me");
	});

	// ADR-0032: refused here rather than sent, because the command exits 0 having claimed nothing.
	test("refuses a key the CLI would read as a flag instead of an issue", () => {
		expect(() => githubClaimCommand({ repo: "example/repo", key: "--help" })).toThrow(/issue number/);
		expect(() => githubClaimCommand({ repo: "example/repo", key: "-h" })).toThrow(/issue number/);
	});

	test("refuses a key that is not one issue number, rather than letting the CLI reject it", () => {
		expect(() => githubClaimCommand({ repo: "example/repo", key: "" })).toThrow(/issue number/);
		expect(() => githubClaimCommand({ repo: "example/repo", key: "7 8" })).toThrow(/issue number/);
		expect(() => githubClaimCommand({ repo: "example/repo", key: "ABC-7" })).toThrow(/issue number/);
	});

	test("refuses a zero-padded key, which the CLI would silently resolve to a different issue", () => {
		expect(() => githubClaimCommand({ repo: "example/repo", key: "037" })).toThrow(/canonical/);
		expect(() => githubClaimCommand({ repo: "example/repo", key: "07" })).toThrow(/canonical/);
		expect(() => githubClaimCommand({ repo: "example/repo", key: "0" })).toThrow(/canonical/);
	});
});

describe("workspaceCommand", () => {
	test("runs the session in the worktree, as a line the workspace's own shell parses back", () => {
		const argv = workspaceCommand({ name: "reader-8", cwd: WORKTREE_PATH, command: SESSION });
		expect(argv[argv.indexOf("--cwd") + 1]).toBe(WORKTREE_PATH);
		expect(argv[argv.indexOf("--command") + 1]).toBe(formatCommand(SESSION));
	});

	test("asks for the workspace to be focused, which the host does not do by default", () => {
		const argv = workspaceCommand({ name: "reader-8", cwd: WORKTREE_PATH, command: SESSION });
		expect(argv[argv.indexOf("--focus") + 1]).toBe("true");
	});

	test("asks the same program the liveness probe does, so one host answers both", () => {
		const argv = workspaceCommand({ name: "reader-8", cwd: WORKTREE_PATH, command: SESSION });
		expect(argv[0]).toBe(workspaceHostAliveCommand()[0]);
	});
});

describe("formatCommand", () => {
	test("renders argv as a line a shell would parse back into the same words", () => {
		expect(formatCommand(["claude", "/implement gh:example/repo#1"])).toBe("claude '/implement gh:example/repo#1'");
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

	/**
	 * Against a real shell, because `workspaceCommand` hands its output to a host that types it into one — so the
	 * quoting is executed rather than only read, and an assertion on the rendered string cannot tell a correct
	 * escape from a plausible one. This is the guard against the tempting edit: every other caller renders for a
	 * human, and prettifying their output by quoting less would weaken this path with nothing else failing.
	 *
	 * `printf '%s\n'` repeats its format once per argument, so each word the shell parsed comes back on its own
	 * line and the comparison is against what the shell actually produced.
	 */
	test("renders words a real shell parses back to exactly those words", () => {
		const words = ["plain", "with space", "it's", "$(id)", "`id`", "a;b", "*", "back\\slash", "", "--flag=v"];
		const line = formatCommand(["printf", "%s\n", ...words]);
		const shell = Bun.spawnSync({ cmd: ["sh", "-c", line], stdout: "pipe", stderr: "pipe" });

		expect(shell.exitCode).toBe(0);
		expect(shell.stdout.toString().split("\n").slice(0, -1)).toEqual(words);
	});
});
