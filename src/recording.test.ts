import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingError, loadRecording, recordingsDir } from "./recording";
import { replayRunner, respondingRunner } from "./test-support";

const scratch = mkdtempSync(join(tmpdir(), "nextup-recording-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function wrote(name: string, contents: string): string {
	const path = join(scratch, name);
	writeFileSync(path, contents);
	return path;
}

const CAPTURED = join(recordingsDir("github"), "ticket-set.json");

describe("loadRecording", () => {
	test("reads a captured exchange with the version of the CLI that produced it", () => {
		const recording = loadRecording(CAPTURED);
		expect(recording.argv[0]).toBe("gh");
		expect(recording.cli).toMatch(/^gh version /);
		expect(recording.code).toBe(0);
		expect(recording.stdout).toMatch(/\S/);
	});

	test("refuses a key it does not know, so a field renamed in capture cannot be silently ignored", () => {
		const path = wrote("extra.json", JSON.stringify({ description: "", cli: "", argv: ["gh"], code: 0, stdout: "", stderr: "", exit: 0 }));
		expect(() => loadRecording(path)).toThrow(/unrecognised key exit/);
	});

	test("refuses a recording missing what a replay needs", () => {
		const path = wrote("thin.json", JSON.stringify({ description: "", cli: "", argv: ["gh"], code: 0, stdout: "" }));
		expect(() => loadRecording(path)).toThrow(RecordingError);
	});

	test("refuses an empty argv, which no exchange could have been captured under", () => {
		const path = wrote("no-argv.json", JSON.stringify({ description: "", cli: "", argv: [], code: 0, stdout: "", stderr: "" }));
		expect(() => loadRecording(path)).toThrow(/non-empty/);
	});

	test("refuses a file that is not a recording at all", () => {
		expect(() => loadRecording(wrote("prose.json", "not json"))).toThrow(RecordingError);
		expect(() => loadRecording(join(scratch, "absent.json"))).toThrow(RecordingError);
	});
});

describe("replayRunner", () => {
	test("answers the argv the exchange was captured under", () => {
		const recording = loadRecording(CAPTURED);
		const result = replayRunner([recording])([...recording.argv]);
		expect(result).toEqual({ code: recording.code, stdout: recording.stdout, stderr: recording.stderr });
	});

	test("refuses a call no recording answers, rather than replying to the wrong question", () => {
		expect(() => replayRunner([loadRecording(CAPTURED)])(["gh", "issue", "list"])).toThrow(/no recording answers/);
	});

	test("refuses two recordings answering one argv, since which of them replies would be undefined", () => {
		const recording = loadRecording(CAPTURED);
		expect(() => replayRunner([recording, recording])).toThrow(/two recordings answer/);
	});
});

describe("respondingRunner", () => {
	test("answers whatever it is asked, for a capture whose own argv cannot be the one under test", () => {
		const recording = loadRecording(CAPTURED);
		expect(respondingRunner(recording)(["git", "status"]).stdout).toBe(recording.stdout);
	});
});
