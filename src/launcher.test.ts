import { describe, expect, test } from "bun:test";
import { DEFAULT_SLASH_COMMAND, formatCommand, workspaceHostAliveCommand } from "./command-builders";
import { LaunchError, launch, planLaunch, requireWorkspaceHost } from "./launcher";
import type { CommandResult, Runner } from "./runner";
import { fakeRunner } from "./test-support";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "1" };
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

	// ADR-0035: there is no fallback, so the message is all a person gets.
	test("refuses a host that does not answer, and says what to do instead", () => {
		const dead = fakeRunner({ code: 1, stdout: "", stderr: "connect: no such file or directory" });
		expect(() => requireWorkspaceHost(dead)).toThrow(LaunchError);
		expect(() => requireWorkspaceHost(dead)).toThrow(/--print-command/);
	});

	test("reports a host that failed silently rather than aborting on an empty reason", () => {
		expect(() => requireWorkspaceHost(fakeRunner({ code: 3, stdout: "", stderr: "" }))).toThrow(/exit 3/);
	});
});

describe("launch", () => {
	test("creates one workspace running the session in the ticket's worktree", () => {
		const { runner, calls } = recording();
		const started = launch({ runner, ref: REF, slashCommand: DEFAULT_SLASH_COMMAND, worktree: WORKTREE });

		expect(calls).toHaveLength(1);
		expect(started.command).toEqual(["claude", "/implement gh:example/repo#1"]);
		expect([...started.workspace]).toEqual(calls[0]!);
		expect(calls[0]![calls[0]!.indexOf("--cwd") + 1]).toBe(WORKTREE);
		expect(calls[0]![calls[0]!.indexOf("--command") + 1]).toBe(formatCommand(started.command));
	});

	test("names the workspace after the worktree, so several running sessions are told apart", () => {
		const { runner, calls } = recording();
		launch({ runner, ref: REF, slashCommand: DEFAULT_SLASH_COMMAND, worktree: WORKTREE });
		expect(calls[0]![calls[0]!.indexOf("--name") + 1]).toBe("reader-1");
	});

	test("runs the slash command it was given rather than the default", () => {
		const { runner, calls } = recording();
		const started = launch({ runner, ref: REF, slashCommand: "/triage", worktree: WORKTREE });
		expect(started.command[1]).toBe("/triage gh:example/repo#1");
		expect(calls[0]![calls[0]!.indexOf("--command") + 1]).toContain("/triage");
	});

	test("aborts on a workspace that could not be created, having tried nothing else", () => {
		const { runner, calls } = recording({ code: 1, stdout: "", stderr: "no window to create a workspace in" });
		expect(() => launch({ runner, ref: REF, slashCommand: DEFAULT_SLASH_COMMAND, worktree: WORKTREE })).toThrow(
			LaunchError,
		);
		expect(calls).toHaveLength(1);
	});

	test("names the ticket in that abort, since the worktree and the claim are already there", () => {
		const { runner } = recording({ code: 1, stdout: "", stderr: "refused" });
		expect(() => launch({ runner, ref: REF, slashCommand: DEFAULT_SLASH_COMMAND, worktree: WORKTREE })).toThrow(
			/gh:example\/repo#1/,
		);
	});

	test("refuses a slash command that is not one before anything is created", () => {
		const { runner, calls } = recording();
		expect(() => launch({ runner, ref: REF, slashCommand: "nope", worktree: WORKTREE })).toThrow(/slash command/);
		expect(calls).toEqual([]);
	});
});
