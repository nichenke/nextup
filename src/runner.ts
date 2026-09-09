import { spawnSync } from "bun";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (argv: string[]) => CommandResult;

/**
 * Environment variables that make git answer about a different repository than the one it was asked about.
 * Which ones do, and how that was measured, is ADR-0026.
 */
const REDIRECTING_GIT_VARIABLES = ["GIT_DIR", "GIT_COMMON_DIR"] as const;

/**
 * @throws Error while the environment points git somewhere else, on every call and without a recovery path.
 * ADR-0026 has why it is refused here rather than stripped or checked in the CLI, and why it is not the same
 * decision as ADR-0025's.
 */
function refuseRedirectedGit(): void {
	const pointed = REDIRECTING_GIT_VARIABLES.filter((name) => (process.env[name] ?? "") !== "");
	if (pointed.length === 0) return;
	throw new Error(
		`${pointed.join(" and ")} ${pointed.length === 1 ? "is" : "are"} set, which points git at a different repository than the one asked about: unset ${pointed.length === 1 ? "it" : "them"} and run again`,
	);
}

export const defaultRunner: Runner = (argv) => {
	// Outside the try, which turns a throw into exit 127 — a redirected environment is not a failed command.
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
