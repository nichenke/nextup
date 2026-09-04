import { describe, expect, test } from "bun:test";
import { defaultRunner } from "./runner";

describe("defaultRunner", () => {
	test("runs a real command and captures its output", () => {
		const result = defaultRunner(["echo", "hi"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});

	test("surfaces a missing binary as a distinct code with the error in stderr, not a blank exit 1", () => {
		const result = defaultRunner(["definitely-not-a-real-binary-xyz"]);
		expect(result.code).toBe(127);
		expect(result.stderr).not.toBe("");
	});
});
