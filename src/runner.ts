import { spawnSync } from "bun";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (argv: string[]) => CommandResult;

/**
 * Environment variables that make git answer about a different repository than the one it was asked about.
 *
 * Measured rather than listed from git's documentation: with `GIT_DIR` or `GIT_COMMON_DIR` set, `git -C
 * <intended> worktree list` reports `<other>`, so `-C` is overridden and every subsequent answer is
 * self-consistent about the wrong repository. `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_NAMESPACE` and
 * `GIT_CEILING_DIRECTORIES` left that command alone, and `GIT_OBJECT_DIRECTORY` broke it outright, which is
 * already loud.
 */
const REDIRECTING_GIT_VARIABLES = ["GIT_DIR", "GIT_COMMON_DIR"] as const;

/**
 * @throws Error while the environment points git somewhere else. Refused rather than stripped: this seam
 * also runs `gh`, `glab` and `jira`, which authenticate from the environment, so removing it would break
 * their credentials to fix git's aim. Refused here rather than in the CLI because this is the one place the
 * tool touches anything outside itself — `CONTEXT.md`'s **Runner** — so no caller can be added that skips it.
 *
 * Loudly, and on every call: the alternative is a run that reads another repository's tickets, writes a
 * branch into it, and reports success. An injected runner is not checked, so tests are unaffected.
 * ADR-0026 has the reasoning, and why this is not the same decision as ADR-0025's.
 */
function refuseRedirectedGit(): void {
	const pointed = REDIRECTING_GIT_VARIABLES.filter((name) => (process.env[name] ?? "") !== "");
	if (pointed.length === 0) return;
	throw new Error(
		`${pointed.join(" and ")} ${pointed.length === 1 ? "is" : "are"} set, which points git at a different repository than the one asked about: unset ${pointed.length === 1 ? "it" : "them"} and run again`,
	);
}

export const defaultRunner: Runner = (argv) => {
	// Before the try, which turns a throw into exit 127 — this must not read as a command that failed.
	refuseRedirectedGit();
	try {
		const result = spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe" });
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (err) {
		return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
};
