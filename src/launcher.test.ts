import { describe, expect, test } from "bun:test";
import { DEFAULT_SLASH_COMMAND, formatCommand, sessionBinaryAliveCommand, workspaceHostAliveCommand } from "./command-builders";
import { LaunchError, launch, planLaunch, requireSessionBinary, requireWorkspaceHost } from "./launcher";
import type { CommandResult, Runner } from "./runner";
import { fakeRunner } from "./test-support";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "github", repo: "example/repo", key: "1" };
const TICKET = { ref: REF, title: "The reader drops a row it cannot parse" };
const WORKTREE = "/repo/.worktrees/reader-1";

const OK: CommandResult = { code: 0, stdout: "PONG\n", stderr: "" };

/** Every call the runner was asked to make, so a test asserts the sequence rather than one argv. */
function recording(result: CommandResult = OK): { runner: Runner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		runner: (argv) => {
			calls.push(argv);
			return result;
		},
	};
}

describe("planLaunch", () => {
	test("produces the command without touching the tracker, which is the sandbox-safe path", () => {
		expect(planLaunch({ ref: REF, slashCommand: DEFAULT_SLASH_COMMAND }).command).toEqual([
			"claude",
			"/implement gh:example/repo#1",
		]);
	});

	test("carries the reason a plan could not be made rather than a bare failure", () => {
		expect(() => planLaunch({ ref: REF, slashCommand: "nope" })).toThrow(/slash command/);
	});
});

describe("requireWorkspaceHost", () => {
	test("asks the host whether it is there, and is satisfied by an answer", () => {
		const { runner, calls } = recording();
		expect(() => requireWorkspaceHost(runner)).not.toThrow();
		expect(calls).toEqual([[...workspaceHostAliveCommand()]]);
	});

	test("refuses a host that does not answer, reporting what the probe said and nothing more", () => {
		const dead = fakeRunner({ code: 1, stdout: "", stderr: "connect: no such file or directory" });
		expect(() => requireWorkspaceHost(dead)).toThrow(LaunchError);
		expect(() => requireWorkspaceHost(dead)).toThrow(/no such file or directory/);
	});

	test("reports a host that failed silently rather than aborting on an empty reason", () => {
		expect(() => requireWorkspaceHost(fakeRunner({ code: 3, stdout: "", stderr: "" }))).toThrow(/exit 3/);
	});
});

describe("requireSessionBinary", () => {
	test("asks the session binary whether it runs, and is satisfied by an answer", () => {
		const { runner, calls } = recording();
		expect(() => requireSessionBinary(runner)).not.toThrow();
		expect(calls).toEqual([[...sessionBinaryAliveCommand()]]);
	});

	/**
	 * The failure ADR-0036 exists for: the host accepts a command without reporting whether it ran, so a binary
	 * that is not there would otherwise reach a claimed ticket and a run saying it started something.
	 */
	test("refuses a binary that will not run, so nothing is claimed on its behalf", () => {
		const missing = fakeRunner({ code: 127, stdout: "", stderr: "command not found: claude" });
		expect(() => requireSessionBinary(missing)).toThrow(LaunchError);
		expect(() => requireSessionBinary(missing)).toThrow(/command not found/);
	});
});

describe("launch", () => {
	const SESSION = planLaunch({ ref: REF, slashCommand: DEFAULT_SLASH_COMMAND }).command;

	test("creates one workspace running the given session in the ticket's worktree", () => {
		const { runner, calls } = recording();
		launch({ runner, ticket: TICKET, command: SESSION, worktree: WORKTREE });

		expect(calls).toHaveLength(1);
		expect(calls[0]![calls[0]!.indexOf("--cwd") + 1]).toBe(WORKTREE);
		expect(calls[0]![calls[0]!.indexOf("--command") + 1]).toBe(formatCommand(SESSION));
	});

	test("names the workspace after the ticket, so several running sessions are told apart", () => {
		const { runner, calls } = recording();
		launch({ runner, ticket: TICKET, command: SESSION, worktree: WORKTREE });
		expect(calls[0]![calls[0]!.indexOf("--name") + 1]).toBe("repo#1");
	});

	test("describes the workspace with the ticket's title, which the name has no room for", () => {
		const { runner, calls } = recording();
		launch({ runner, ticket: TICKET, command: SESSION, worktree: WORKTREE });
		expect(calls[0]![calls[0]!.indexOf("--description") + 1]).toBe(TICKET.title);
	});

	test("passes a title that looks like a flag through as the description, not as an argument of its own", () => {
		const { runner, calls } = recording();
		const awkward = { ref: REF, title: "--focus false is ignored on a second call" };
		launch({ runner, ticket: awkward, command: SESSION, worktree: WORKTREE });
		expect(calls[0]![calls[0]!.indexOf("--description") + 1]).toBe(awkward.title);
	});

	/** `text` in the GitHub adapter admits an empty string where its sibling `url` refuses one, so a ticket can
	 * reach here with no title at all. */
	test("still passes a description for a ticket with no title", () => {
		const { runner, calls } = recording();
		launch({ runner, ticket: { ref: REF, title: "" }, command: SESSION, worktree: WORKTREE });
		expect(calls[0]!.indexOf("--description")).toBeGreaterThan(-1);
		expect(calls[0]![calls[0]!.indexOf("--description") + 1]).toBe("");
	});

	test("runs whatever session argv it was handed, rather than building one of its own", () => {
		const { runner, calls } = recording();
		const triage = planLaunch({ ref: REF, slashCommand: "/triage" }).command;
		launch({ runner, ticket: TICKET, command: triage, worktree: WORKTREE });
		expect(calls[0]![calls[0]!.indexOf("--command") + 1]).toContain("/triage");
	});

	test("aborts on a workspace that could not be created, having tried nothing else", () => {
		const { runner, calls } = recording({ code: 1, stdout: "", stderr: "no window to create a workspace in" });
		expect(() => launch({ runner, ticket: TICKET, command: SESSION, worktree: WORKTREE })).toThrow(LaunchError);
		expect(calls).toHaveLength(1);
	});

	test("names the ticket and what the host said, and prescribes no recovery of its own", () => {
		const { runner } = recording({ code: 1, stdout: "", stderr: "no window" });
		try {
			launch({ runner, ticket: TICKET, command: SESSION, worktree: WORKTREE });
			throw new Error("expected a refusal");
		} catch (cause) {
			const message = (cause as Error).message;
			expect(message).toContain("gh:example/repo#1");
			expect(message).toContain("no window");
			// The caller decides that, because what is recoverable depends on how much had been written.
			expect(message).not.toContain("running this again");
		}
	});
});
