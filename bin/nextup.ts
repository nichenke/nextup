#!/usr/bin/env bun
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { type Confirm, run } from "../src/cli";
import { defaultRunner } from "../src/runner";

// A reader that closes early — `nextup --json | head`, or a pager the user quits — makes the next
// write raise EPIPE. Unhandled, that crashes with exit 1, which this command defines as nothing
// started, so piping a real pick into `head` reports a quiet day. Swallowing only EPIPE leaves every
// other stream failure loud.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
}

/**
 * Asks on the controlling terminal rather than through stdin and stdout, so the gate still works when
 * either has been redirected — `nextup | tee log` is exactly when a person most wants to be asked, and
 * reading fd 0 there would consume the pipe instead.
 *
 * Anything but `y` or `yes` is a no, including an empty line and a terminal already at end of input,
 * which reads as zero bytes: the prompt says `[y/N]`, and a gate that treats a stray keystroke or a
 * closed input as approval is not one.
 */
const askOnTerminal: Confirm = (question) => {
	const tty = openSync("/dev/tty", "r+");
	try {
		writeSync(tty, `${question} `);
		const buffer = Buffer.alloc(64);
		const read = readSync(tty, buffer, 0, buffer.length, null);
		const answer = buffer.toString("utf8", 0, read).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		closeSync(tty);
	}
};

function terminal(): Confirm | null {
	try {
		closeSync(openSync("/dev/tty", "r+"));
	} catch {
		return null;
	}
	return askOnTerminal;
}

const result = run(process.argv.slice(2), { cwd: process.cwd(), runner: defaultRunner, confirm: terminal() });
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
// Setting the code and letting the process end, rather than `process.exit`, which tears the process
// down before an asynchronous pipe write drains — a `--json` document longer than the pipe buffer
// reached a slow reader truncated, and still exited 0.
process.exitCode = result.code;
