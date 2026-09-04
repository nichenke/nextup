import type { ClaimHold, Claimer } from "./claim";
import { sessionCommand } from "./command-builders";
import type { TicketRef } from "./ticket-ref";

export class LaunchError extends Error {}

export interface LaunchPlanInput {
	readonly ref: TicketRef;
	readonly slashCommand: string;
}

/** Everything the launcher would do, worked out without doing any of it. */
export interface LaunchPlan {
	readonly command: readonly string[];
}

export interface LaunchInput extends LaunchPlanInput {
	readonly claimer: Claimer;
}

export interface Launch extends LaunchPlan {
	readonly hold: ClaimHold;
}

/**
 * The launch as a plan: what would be run, worked out from the pick alone. Nothing here reads or
 * writes anything outside the process, which is what makes `--print-command` safe to run confined —
 * ADR-0002 has why the tool is split this way.
 */
export function planLaunch(input: LaunchPlanInput): LaunchPlan {
	return { command: sessionCommand(input) };
}

/**
 * Claims the ticket, then plans the launch.
 *
 * The order is the point. The claim is written into the tracker before anything local exists, so a
 * failure leaves a visible wrong state somebody can see and correct rather than an orphan on a disk
 * nobody is looking at. A claim that cannot land aborts here, having changed nothing.
 */
export function prepareLaunch(input: LaunchInput): Launch {
	const hold = input.claimer.claim();
	const plan = beforeWorktreeExists(input.claimer, () => planLaunch(input));
	return { ...plan, hold };
}

/**
 * Runs `work` with the claim given back if it fails. This is the boundary the spec draws: up to here a
 * failure leaves nothing behind, so holding the claim would advertise a ticket nobody is working as
 * taken. Past here a worktree exists, and the claim is kept precisely so a ticket carrying a
 * half-finished branch is never handed to somebody else — so ticket 08's worktree step goes *outside*
 * this call rather than inside it.
 *
 * @throws LaunchError when the claim could not be given back either, naming both failures. A release
 * that fails leaves a real claimed-but-idle ticket, which a caller told only about the first failure
 * would not know to go and clear.
 */
export function beforeWorktreeExists<T>(claimer: Claimer, work: () => T): T {
	try {
		return work();
	} catch (cause) {
		const outcome = claimer.release();
		if (outcome.released) throw cause;
		throw new LaunchError(`${message(cause)}; the claim was not given back either: ${outcome.reason}`, { cause });
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
