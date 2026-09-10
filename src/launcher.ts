import { basename } from "node:path";
import {
	type Argv,
	formatCommand,
	sessionCommand,
	workspaceCommand,
	workspaceHostAliveCommand,
} from "./command-builders";
import { failureDetail } from "./failure-class";
import type { Runner } from "./runner";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

/**
 * Why no session was started. One class rather than an outage-and-defect pair: both answers here are the
 * same, because a launch has nothing to degrade to and nothing to retry past — ADR-0035.
 */
export class LaunchError extends Error {}

export interface LaunchPlanInput {
	readonly ref: TicketRef;
	readonly slashCommand: string;
}

/** Everything the launcher would do, worked out without doing any of it. */
export interface LaunchPlan {
	readonly command: Argv;
}

/**
 * The launch as a plan: what would be run, worked out from the pick alone. Nothing here reads or
 * writes anything outside the process — ADR-0002 has why the tool is split this way.
 */
export function planLaunch(input: LaunchPlanInput): LaunchPlan {
	return { command: sessionCommand(input) };
}

/**
 * Refuses the run unless the workspace host answers.
 *
 * Asked before the worktree and the claim, which is the whole reason it is a separate call rather than part of
 * `launch` — a host that will not serve should not leave those two behind. ADR-0035 has why there is no
 * fallback.
 *
 * @throws LaunchError when the host does not answer.
 */
export function requireWorkspaceHost(runner: Runner): void {
	const argv = workspaceHostAliveCommand();
	const result = runner([...argv]);
	if (result.code === 0) return;
	throw new LaunchError(`${formatCommand(argv)} failed, so nothing was started: ${failureDetail(result)}`);
}

export interface LaunchInput {
	readonly runner: Runner;
	readonly ref: TicketRef;
	/** The session argv to run, built by `planLaunch` before any of this was written. */
	readonly command: Argv;
	/** The worktree the session runs in, whose own directory name is what the workspace is called. */
	readonly worktree: string;
}

/**
 * Starts a session on one ticket, in the worktree already made for it.
 *
 * One call, whose exit status is the whole verdict, so there is nothing to return: it started or it threw.
 * No rollback, no retry, and no second host to try — ADR-0016 has why nothing here unwinds, and ADR-0035 why
 * a host that will not serve is a refusal rather than something to work around.
 *
 * The failure names the ticket and what the host said, and stops there. What to do about it depends on how
 * much had already been written, which only the caller knows; `startedNothing` in `cli.ts` is where that is
 * decided, and saying it here too produced two overlapping recovery sentences.
 *
 * @throws LaunchError when the workspace could not be created.
 */
export function launch(input: LaunchInput): void {
	const workspace = workspaceCommand({ name: basename(input.worktree), cwd: input.worktree, command: input.command });
	const result = input.runner([...workspace]);
	if (result.code !== 0) {
		throw new LaunchError(`the workspace for ${formatTicketRef(input.ref)} could not be created: ${failureDetail(result)}`);
	}
}
