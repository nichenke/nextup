import { describe, expect, test } from "bun:test";
import type { ClaimHold, Claimer, ReleaseOutcome } from "./claim";
import { ClaimError } from "./claim";
import { DEFAULT_SLASH_COMMAND } from "./command-builders";
import { LaunchError, planLaunch, prepareLaunch } from "./launcher";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "markdown", repo: null, host: null, key: "1" };

/** A claimer that records what it was asked to do, since the order is the thing under test. */
function recordingClaimer(options: { claim?: () => ClaimHold; release?: () => ReleaseOutcome } = {}): {
	claimer: Claimer;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		claimer: {
			claim() {
				calls.push("claim");
				return options.claim?.() ?? { ref: REF, claimant: null };
			},
			release() {
				calls.push("release");
				return options.release?.() ?? { released: true };
			},
		},
	};
}

describe("prepareLaunch", () => {
	test("claims the ticket, then produces the command that would start work on it", () => {
		const { claimer, calls } = recordingClaimer();
		const launch = prepareLaunch({ ref: REF, claimer, slashCommand: DEFAULT_SLASH_COMMAND });

		expect(calls).toEqual(["claim"]);
		expect(launch.hold).toEqual({ ref: REF, claimant: null });
		expect(launch.command).toEqual(["claude", "/implement md:1"]);
	});

	test("a claim that cannot land aborts, with nothing released and no command produced", () => {
		const { claimer, calls } = recordingClaimer({
			claim() {
				throw new ClaimError("taken");
			},
		});

		expect(() => prepareLaunch({ ref: REF, claimer, slashCommand: DEFAULT_SLASH_COMMAND })).toThrow(ClaimError);
		expect(calls).toEqual(["claim"]);
	});

	test("a failure before the worktree exists gives the claim back", () => {
		const { claimer, calls } = recordingClaimer();

		expect(() => prepareLaunch({ ref: REF, claimer, slashCommand: "not-a-slash-command" })).toThrow();
		expect(calls).toEqual(["claim", "release"]);
	});

	test("reports both failures when the claim could not be given back either", () => {
		const { claimer } = recordingClaimer({ release: () => ({ released: false, reason: "the file changed" }) });

		expect(() => prepareLaunch({ ref: REF, claimer, slashCommand: "not-a-slash-command" })).toThrow(
			/the file changed/,
		);
	});
});

describe("planLaunch", () => {
	test("produces the command without touching the tracker, which is the sandbox-safe path", () => {
		expect(planLaunch({ ref: REF, slashCommand: DEFAULT_SLASH_COMMAND }).command).toEqual([
			"claude",
			"/implement md:1",
		]);
	});

	test("carries the reason a plan could not be made rather than a bare failure", () => {
		expect(() => planLaunch({ ref: REF, slashCommand: "nope" })).toThrow(/slash command/);
	});
});

describe("LaunchError", () => {
	test("keeps the original failure as its cause, so the reason a launch stopped is not lost", () => {
		const { claimer } = recordingClaimer({ release: () => ({ released: false, reason: "the file changed" }) });
		try {
			prepareLaunch({ ref: REF, claimer, slashCommand: "nope" });
			expect.unreachable();
		} catch (cause) {
			expect(cause).toBeInstanceOf(LaunchError);
			expect((cause as LaunchError).cause).toBeInstanceOf(Error);
		}
	});
});
