import { describe, expect, test } from "bun:test";
import type { ClaimHold, Claimer, ReleaseOutcome } from "./claim";
import { ClaimError } from "./claim";
import { DEFAULT_SLASH_COMMAND } from "./command-builders";
import { type LaunchPlan, LaunchError, beforeWorktreeExists, planLaunch, prepareLaunch } from "./launcher";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "markdown", repo: null, host: null, key: "1" };

const approve = (): boolean => true;

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
				return options.claim?.() ?? { ref: REF, claimant: { by: null } };
			},
			release() {
				calls.push("release");
				return options.release?.() ?? { kind: "released" };
			},
		},
	};
}

describe("prepareLaunch", () => {
	test("claims the ticket, and carries the command that would start work on it", () => {
		const { claimer, calls } = recordingClaimer();
		const outcome = prepareLaunch({ ref: REF, claimer, slashCommand: DEFAULT_SLASH_COMMAND, confirm: approve });

		expect(calls).toEqual(["claim"]);
		expect(outcome.kind).toBe("launched");
		if (outcome.kind !== "launched") return;
		expect(outcome.launch.hold).toEqual({ ref: REF, claimant: { by: null } });
		expect(outcome.launch.command).toEqual(["claude", "/implement md:1"]);
	});

	// The gate is asked with the finished plan and answered before the only write, so declining costs
	// the tracker nothing and there is no claim to give back.
	test("writes nothing when the plan is declined, and shows the plan being declined", () => {
		const { claimer, calls } = recordingClaimer();
		const asked: LaunchPlan[] = [];

		const outcome = prepareLaunch({
			ref: REF,
			claimer,
			slashCommand: DEFAULT_SLASH_COMMAND,
			confirm: (plan) => {
				asked.push(plan);
				return false;
			},
		});

		// The plan survives the decline, so a caller can still report what it was going to run.
		expect(outcome).toEqual({ kind: "declined", plan: { command: ["claude", "/implement md:1"] } });
		expect(calls).toEqual([]);
		expect(asked).toEqual([{ command: ["claude", "/implement md:1"] }]);
	});

	test("a claim that cannot land aborts, with nothing released and no command produced", () => {
		const { claimer, calls } = recordingClaimer({
			claim() {
				throw new ClaimError("taken", "unavailable");
			},
		});

		expect(() =>
			prepareLaunch({ ref: REF, claimer, slashCommand: DEFAULT_SLASH_COMMAND, confirm: approve }),
		).toThrow(ClaimError);
		expect(calls).toEqual(["claim"]);
	});

	// The plan is pure, so an input that was already wrong costs no tracker write to find out — and
	// there is no claim to give back afterwards.
	test("writes nothing when the input was wrong before anything was touched", () => {
		const { claimer, calls } = recordingClaimer();

		expect(() =>
			prepareLaunch({ ref: REF, claimer, slashCommand: "not-a-slash-command", confirm: approve }),
		).toThrow();
		expect(calls).toEqual([]);
	});
});

describe("beforeWorktreeExists", () => {
	test("passes work through untouched, holding the claim", () => {
		const { claimer, calls } = recordingClaimer();
		expect(beforeWorktreeExists(claimer, () => "done")).toBe("done");
		expect(calls).toEqual([]);
	});

	test("gives the claim back when the work fails, since nothing local exists to keep it for", () => {
		const { claimer, calls } = recordingClaimer();

		expect(() => {
			beforeWorktreeExists(claimer, () => {
				throw new Error("no worktree yet");
			});
		}).toThrow("no worktree yet");
		expect(calls).toEqual(["release"]);
	});

	test("reports both failures when the claim is left stranded", () => {
		const { claimer } = recordingClaimer({ release: () => ({ kind: "stranded", reason: "the file changed" }) });

		expect(() => {
			beforeWorktreeExists(claimer, () => {
				throw new Error("no worktree yet");
			});
		}).toThrow(/the file changed/);
	});

	// Nothing is outstanding, so the original failure is the whole story and wrapping it would send a
	// caller looking for a claim to clear that was never taken.
	test("passes the failure through when there was no claim to give back", () => {
		const { claimer } = recordingClaimer({ release: () => ({ kind: "nothing-to-release" }) });

		expect(() => {
			beforeWorktreeExists(claimer, () => {
				throw new Error("no worktree yet");
			});
		}).toThrow("no worktree yet");
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
		const { claimer } = recordingClaimer({ release: () => ({ kind: "stranded", reason: "the file changed" }) });
		try {
			beforeWorktreeExists(claimer, () => {
				throw new Error("no worktree yet");
			});
			expect.unreachable();
		} catch (cause) {
			expect(cause).toBeInstanceOf(LaunchError);
			expect((cause as LaunchError).cause).toBeInstanceOf(Error);
		}
	});
});
