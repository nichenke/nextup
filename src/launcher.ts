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
	/**
	 * Answered with the finished plan, and before the claim, which is the first thing that writes. Asked
	 * any earlier and the answer would be given without the command it approves; any later and it would
	 * be given after the tracker had already been told.
	 */
	readonly confirm: (plan: LaunchPlan) => boolean;
	/**
	 * Checked after the gate and before the claim, throwing where the pick is no longer one to start.
	 *
	 * It runs here because the gate is where the wait is. Selection and claim used to be microseconds
	 * apart; a question put to a person holds that window open for as long as they take to answer, and
	 * what was startable when it was asked may not be when it is answered.
	 */
	readonly recheck: () => void;
}

export interface Launch extends LaunchPlan {
	readonly hold: ClaimHold;
}

/**
 * What a run did about its plan. Tagged rather than `Launch | null`, because `null` is already how a
 * run with no plan at all is reported and the two would be indistinguishable to a consumer — a
 * declined pick would read as one that was never worked out, losing the command the gate had already
 * shown. `planned` is the run that never asked, which is `--print-command`.
 */
export type LaunchOutcome =
	| { readonly kind: "planned"; readonly plan: LaunchPlan }
	| PreparedLaunch;

/**
 * The two a run that went through the gate can end on. Narrower than `LaunchOutcome` so that reaching
 * for the claim has to exclude the decline first — `planned` belongs to the path that never asked, and
 * leaving it in would put a case in every caller that none of them can reach.
 */
export type PreparedLaunch =
	| { readonly kind: "declined"; readonly plan: LaunchPlan }
	| { readonly kind: "launched"; readonly launch: Launch };

/**
 * The launch as a plan: what would be run, worked out from the pick alone. Nothing here reads or
 * writes anything outside the process, which is what makes `--print-command` safe to run confined —
 * ADR-0002 has why the tool is split this way.
 */
export function planLaunch(input: LaunchPlanInput): LaunchPlan {
	return { command: sessionCommand(input) };
}

export function prepareLaunch(input: LaunchInput): PreparedLaunch {
	const plan = planLaunch(input);
	if (!input.confirm(plan)) return { kind: "declined", plan };
	input.recheck();
	return { kind: "launched", launch: { ...plan, hold: input.claimer.claim() } };
}

/**
 * Runs `work` with the claim given back if it fails, for the steps between a claim and a worktree.
 * Up to here a failure leaves nothing behind, so holding the claim would advertise a ticket nobody is
 * working as taken. Past here a worktree exists, and the claim is kept precisely so a ticket carrying
 * a half-finished branch is never handed to somebody else — so ticket 08's worktree step goes
 * *outside* this call rather than inside it.
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
