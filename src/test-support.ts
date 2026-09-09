import { join } from "node:path";
import { type Recording, RecordingError, loadRecording, recordingsDir } from "./recording";
import type { CommandResult, Runner } from "./runner";
import { DEGRADED_PREFIX } from "./selection-output";

/** One stored GitHub recording by name, so no test spells the corpus layout for itself. */
export function githubRecording(name: string): Recording {
	return loadRecording(join(recordingsDir("github"), `${name}.json`));
}

/** The sentinel lines of a rendering, which is the contract `DEGRADED_PREFIX` exists to be tested through. */
export function sentinelLines(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith(DEGRADED_PREFIX));
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
