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
 * The plan, and a claim on the ticket it is for. The claim is the last thing that happens, and the
 * first thing that writes: everything before it is pure, so an input that was already wrong costs no
 * tracker write to find out.
 */
export function prepareLaunch(input: LaunchInput): Launch {
	const plan = planLaunch(input);
	return { ...plan, hold: input.claimer.claim() };
}

/**
 * Runs `work` with the claim given back if it fails. This is the boundary the spec draws: up to here a
 * failure leaves nothing behind, so holding the claim would advertise a ticket nobody is working as
 * taken. Past here a worktree exists, and the claim is kept precisely so a ticket carrying a
 * half-finished branch is never handed to somebody else — so ticket 08's worktree step goes *outside*
 * this call rather than inside it.
 *
 * Nothing between the claim and the worktree can fail yet, so ticket 08 is the first caller with work
 * to pass. It is written and tested here because it is this ticket that decides where the line falls.
 *
 * @throws LaunchError only when the claim is left stranded, naming both failures — a caller told just
 * the first would not know there is a claim to go and clear. A claimer that never claimed has nothing
 * to strand, so the original failure passes through untouched.
 */
export function beforeWorktreeExists<T>(claimer: Claimer, work: () => T): T {
	try {
		return work();
	} catch (cause) {
		const outcome = claimer.release();
		if (outcome.kind !== "stranded") throw cause;
		throw new LaunchError(`${message(cause)}; the claim was not given back either: ${outcome.reason}`, { cause });
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
