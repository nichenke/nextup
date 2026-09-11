import { join } from "node:path";
import { type Recording, RecordingError, loadRecording, recordingsDir } from "./recording";
import type { CommandResult, Runner } from "./runner";
import { DEADLOCK_PREFIX, DEGRADED_PREFIX } from "./selection-output";

/** One stored GitHub recording by name, so no test spells the corpus layout for itself. */
export function githubRecording(name: string): Recording {
	return loadRecording(join(recordingsDir("github"), `${name}.json`));
}

/**
 * A runner answering the origin-remote question with `remote`, and every other call from `answer`. One
 * definition of how that call is faked, so a change to the argv a read resolves its repository through
 * cannot leave some tests answering the old shape.
 *
 * Matched on the key rather than on the whole argv, which carries a directory the caller chooses, and on the
 * key rather than on `git` alone, so any other git command still reaches `answer` and fails there visibly.
 */
export function answeringOrigin(remote: string, answer: Runner): Runner {
	return (argv) => (isOriginRead(argv) ? { code: 0, stdout: `${remote}\n`, stderr: "" } : answer(argv));
}

/** Whether an argv is the origin read, for a test faking or counting it. The key is the word only it carries. */
export function isOriginRead(argv: readonly string[]): boolean {
	return argv[0] === "git" && argv.includes(ORIGIN_URL_KEY);
}

const ORIGIN_URL_KEY = "remote.origin.url";

/** The sentinel lines of a rendering, which is the contract `DEGRADED_PREFIX` exists to be tested through. */
export function sentinelLines(text: string): string[] {
	return linesWithPrefix(text, DEGRADED_PREFIX);
}

/** The deadlock lines of a rendering, the same contract for `DEADLOCK_PREFIX` that `sentinelLines` is. */
export function deadlockLines(text: string): string[] {
	return linesWithPrefix(text, DEADLOCK_PREFIX);
}

function linesWithPrefix(text: string, prefix: string): string[] {
	return text.split("\n").filter((line) => line.startsWith(prefix));
}

export function fakeRunner(result: CommandResult): Runner {
	return () => result;
}

export function routedRunner(routes: Record<string, CommandResult>): Runner {
	return (argv) => routes[argv.join(" ")] ?? { code: 1, stdout: "", stderr: "" };
}

/**
 * A runner answering each call from the recording captured for exactly that argv, and refusing any other
 * call. The argv match is the point rather than a convenience: it makes a test of what a read *parses* also a
 * test of what it *asks*, so a field quietly dropped from the query fails here. That strictness is why this
 * exists beside `routedRunner`, which answers a miss with a plain failure.
 *
 * @throws RecordingError when two recordings share an argv. The returned runner throws the same when a call
 * matches no recording.
 */
export function replayRunner(recordings: readonly Recording[]): Runner {
	const byArgv = new Map<string, CommandResult>();
	for (const recording of recordings) {
		const key = JSON.stringify(recording.argv);
		if (byArgv.has(key)) throw new RecordingError(`two recordings answer ${key}, so which one replies is undefined`);
		byArgv.set(key, responseOf(recording));
	}
	return (argv) => {
		const result = byArgv.get(JSON.stringify(argv));
		if (result === undefined) throw new RecordingError(`no recording answers ${JSON.stringify(argv)}`);
		return result;
	};
}

/**
 * A runner answering every call with one recording's response, for the failure shapes whose own argv names
 * something the code under test never asks for — an unreachable host, or a projection deliberately missing a
 * field. `replayRunner` is the default; reach for this only when the captured argv cannot be the one the
 * caller emits, since it asserts nothing about what was asked.
 */
export function respondingRunner(recording: Recording): Runner {
	return fakeRunner(responseOf(recording));
}

function responseOf(recording: Recording): CommandResult {
	return { code: recording.code, stdout: recording.stdout, stderr: recording.stderr };
}

/**
 * The issue a single-ticket recording answered about, read off the row it carries rather than written down here:
 * a rebuilt tree renumbers, per ADR-0023.
 *
 * Deliberately not taken from the recording's own argv, for the reason `github-claim.test.ts` gives about the
 * claim — `replayRunner` answers only the argv it captured, so a key read off that argv would match by
 * construction and assert nothing about what the read asks for.
 *
 * @throws RecordingError when the recording's response names no issue number, which means it is not a
 * single-ticket read, and SyntaxError from `JSON.parse` when its stdout is not JSON at all.
 */
export function recordedIssue(recording: Recording): string {
	const number = (JSON.parse(recording.stdout) as { number?: unknown }).number;
	if (typeof number !== "number") throw new RecordingError(`${recording.description} answered about no issue number`);
	return String(number);
}
