import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandResult, Runner } from "./runner";
import type { Tracker } from "./ticket-ref";

export class RecordingError extends Error {}

/**
 * One captured call-and-response exchange at the runner seam. Never hand-written: a recording asserts that
 * a tracker's CLI produces a shape, so it has to come from one — ADR-0019, and `docs/agents/test-tree.md`
 * for which tree and how to capture.
 */
export interface Recording {
	readonly description: string;
	/** The version line of the CLI that produced this, so a change in what it prints is attributable. */
	readonly cli: string;
	readonly argv: readonly string[];
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Where a tracker's recordings live, resolved from this file so a caller's own directory cannot skew it. */
export function recordingsDir(tracker: Tracker): string {
	return join(dirname(import.meta.dir), "fixtures", "recordings", tracker);
}

export function loadRecording(path: string): Recording {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new RecordingError(`${path} is not a readable recording: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new RecordingError(`${path} must hold one recording object`);
	}
	const fields = raw as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!FIELDS.includes(key)) throw new RecordingError(`${path} has an unrecognised key ${key} (expected ${FIELDS.join(", ")})`);
	}
	return {
		description: text(fields.description, path, "description"),
		cli: text(fields.cli, path, "cli"),
		argv: words(fields.argv, path),
		code: whole(fields.code, path),
		stdout: text(fields.stdout, path, "stdout"),
		stderr: text(fields.stderr, path, "stderr"),
	};
}

const FIELDS: readonly string[] = ["description", "cli", "argv", "code", "stdout", "stderr"];

/**
 * A runner answering each call from the recording captured for exactly that argv, and refusing any other
 * call. The argv match is the point rather than a convenience: it makes a test of what a read *parses*
 * also a test of what it *asks*, so a field quietly dropped from the query fails here.
 *
 * @throws RecordingError when two recordings share an argv, or when a call matches none.
 */
export function replayRunner(recordings: readonly Recording[]): Runner {
	const byArgv = new Map<string, CommandResult>();
	for (const recording of recordings) {
		const key = JSON.stringify(recording.argv);
		if (byArgv.has(key)) throw new RecordingError(`two recordings answer ${key}, so which one replies is undefined`);
		byArgv.set(key, { code: recording.code, stdout: recording.stdout, stderr: recording.stderr });
	}
	return (argv) => {
		const result = byArgv.get(JSON.stringify(argv));
		if (result === undefined) throw new RecordingError(`no recording answers ${JSON.stringify(argv)}`);
		return result;
	};
}

/**
 * A runner answering every call with one recording's response, for the failure shapes whose own argv names
 * something the code under test never asks for — an unreachable host, or a projection deliberately missing
 * a field. `replayRunner` is the default; reach for this only when the captured argv cannot be the one the
 * caller emits, since it asserts nothing about what was asked.
 */
export function respondingRunner(recording: Recording): Runner {
	return () => ({ code: recording.code, stdout: recording.stdout, stderr: recording.stderr });
}

function text(raw: unknown, path: string, where: string): string {
	if (typeof raw !== "string") throw new RecordingError(`${path}: ${where} must be a string`);
	return raw;
}

function words(raw: unknown, path: string): readonly string[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new RecordingError(`${path}: argv must be a non-empty array`);
	return raw.map((word, index) => text(word, path, `argv[${index}]`));
}

function whole(raw: unknown, path: string): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new RecordingError(`${path}: code must be a whole number`);
	return raw;
}
