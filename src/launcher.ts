import { sessionCommand } from "./command-builders";
import type { TicketRef } from "./ticket-ref";

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
