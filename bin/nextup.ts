#!/usr/bin/env bun
import { run } from "../src/cli";

const result = run(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
// Setting the code and letting the process end, rather than `process.exit`, which tears the process
// down before an asynchronous pipe write drains — a `--json` document longer than the pipe buffer
// reached a slow reader truncated, and still exited 0.
process.exitCode = result.code;
