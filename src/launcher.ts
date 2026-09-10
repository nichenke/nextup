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
	readonly command: readonly string[];
}

/**
 * The launch as a plan: what would be run, worked out from the pick alone. Nothing here reads or
 * writes anything outside the process — ADR-0002 has why the tool is split this way.
 */
export function planLaunch(input: LaunchPlanInput): LaunchPlan {
	return { command: sessionCommand(input) };
}

/**
 * Refuses the run unless the workspace host is there to start a session in.
 *
 * Asked before the worktree and the claim, which is the whole reason it is a separate call. ADR-0016
 * orders the worktree first so a failure leaves a directory rather than an operator's name parked on work
 * nobody is doing — but a launch happens after both, so its failure leaves exactly that. Asking first
 * turns the one cause a person can act on into a refusal that has written nothing.
 *
 * It narrows that window rather than closing it: the host can still go away between here and `launch`,
 * where the creation's own exit status is the verdict. ADR-0035 has both halves.
 *
 * @throws LaunchError when the host does not answer.
 */
export function requireWorkspaceHost(runner: Runner): void {
	const argv = workspaceHostAliveCommand();
	const result = runner([...argv]);
	if (result.code === 0) return;
	throw new LaunchError(
		`${formatCommand(argv)} did not answer, so there is no workspace host to start a session in: ${failureDetail(result)}. Start it and run this again, or use --print-command to get the command and start the session yourself.`,
	);
}

export interface LaunchInput {
	readonly runner: Runner;
	readonly ref: TicketRef;
	readonly slashCommand: string;
	/** The worktree the session runs in, whose own directory name is what the workspace is called. */
	readonly worktree: string;
}

export interface Launch {
	/** The session argv the workspace was told to run, so a caller reports what started rather than restating it. */
	readonly command: readonly string[];
	readonly workspace: Argv;
}

/**
 * Starts a session on one ticket, in the worktree already made for it.
 *
 * One call, whose exit status is the whole verdict. No rollback, no retry, and no second host to try:
 * ADR-0016 has why nothing here unwinds, and ADR-0035 why a host that will not serve is a refusal rather
 * than something to work around.
 *
 * @throws LaunchError when the workspace could not be created.
 * @throws CommandBuilderError when `slashCommand` is not a single `/`-prefixed word, which is refused
 * before anything is created.
 */
export function launch(input: LaunchInput): Launch {
	const command = sessionCommand(input);
	const workspace = workspaceCommand({ name: basename(input.worktree), cwd: input.worktree, command });
	const result = input.runner([...workspace]);
	if (result.code !== 0) {
		throw new LaunchError(
			`the workspace for ${formatTicketRef(input.ref)} could not be created: ${failureDetail(result)}. Its worktree and its claim are both in place, so running this again starts the session without redoing either.`,
		);
	}
	return { command, workspace };
}
