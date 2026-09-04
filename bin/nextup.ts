#!/usr/bin/env bun
import { run } from "../src/cli";

const result = run(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exit(result.code);
