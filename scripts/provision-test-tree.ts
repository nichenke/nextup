#!/usr/bin/env bun
import { defaultRunner } from "../src/runner";
import { GITHUB_TEST_TREE } from "../src/test-tree";
import { provisionTestTree } from "../src/test-tree-provision";

try {
	const report = provisionTestTree(GITHUB_TEST_TREE, defaultRunner);
	for (const change of report.changes) process.stdout.write(`${change.key}: ${change.action}\n`);
	process.stdout.write(
		report.changes.length === 0
			? `${GITHUB_TEST_TREE.repo} already matches the spec\n`
			: `${GITHUB_TEST_TREE.repo}: ${report.changes.length} change(s)\n`,
	);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
