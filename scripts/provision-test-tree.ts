#!/usr/bin/env bun
import { defaultRunner } from "../src/runner";
import { GITHUB_TEST_TREE, TestTreeError } from "../src/test-tree";
import { provisionTestTree } from "../src/test-tree-provision";

try {
	const report = provisionTestTree(GITHUB_TEST_TREE, defaultRunner);
	for (const change of report.changes) process.stdout.write(`${change.key}: ${change.action}\n`);
	process.stdout.write(
		report.changes.length === 0
			? `${GITHUB_TEST_TREE.repo}: every issue already matches the spec\n`
			: `${GITHUB_TEST_TREE.repo}: ${report.changes.length} change(s)\n`,
	);
} catch (error) {
	if (error instanceof TestTreeError) {
		for (const change of error.changes) process.stdout.write(`${change.key}: ${change.action}\n`);
		if (error.changes.length > 0) {
			process.stdout.write(`${error.changes.length} change(s) landed before the failure\n`);
		}
	}
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
