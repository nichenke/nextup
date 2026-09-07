import { describe, expect, test } from "bun:test";
import { DEFAULT_SLASH_COMMAND } from "./command-builders";
import { planLaunch } from "./launcher";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "github", repo: "example/repo", host: null, key: "1" };

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
