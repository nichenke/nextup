#!/usr/bin/env bun
import { run } from "../src/cli";

// A reader that closes early — `nextup --json | head`, or a pager the user quits — makes the next
// write raise EPIPE. Unhandled, that crashes with exit 1, which this command defines as "nothing to
// recommend", so piping a real pick into `head` reports an empty ticket set. Swallowing only EPIPE
// leaves every other stream failure loud.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
}

const result = run(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
// Setting the code and letting the process end, rather than `process.exit`, which tears the process
// down before an asynchronous pipe write drains — a `--json` document longer than the pipe buffer
// reached a slow reader truncated, and still exited 0.
process.exitCode = result.code;
