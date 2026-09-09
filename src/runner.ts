import { spawnSync } from "bun";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (argv: string[]) => CommandResult;

/**
 * The runner refusing to run anything at all, as against a command that ran and failed. Its own class so a
 * caller can report the recovery path rather than a stack: `cli.ts` prints the stack of an error nobody has
 * classified, and this one is classified. Nothing in this file throws it since ADR-0029 replaced the refusal
 * with a scrub; `cli.ts` still classifies it, so the seam keeps the class for a future one.
 */
export class RunnerRefusal extends Error {}

/**
 * Removed without the notice the other `GIT_`-prefixed names get. A name belongs here only once measured
 * against the whole command set as changing no answer, and only if ordinary tooling exports it. ADR-0029.
 */
const UNREPORTED_GIT_VARIABLES: ReadonlySet<string> = new Set(["GIT_EDITOR", "GIT_PAGER"]);

export interface GitEnvironment {
	/** `source` less every `GIT_`-prefixed name, whatever its value. Readonly, or a caller can put one back. */
	readonly env: Readonly<Record<string, string>>;
	/** The removed names worth reporting, sorted, so one message reads the same run to run. */
	readonly reportable: readonly string[];
}

/**
 * The environment a git command is given: `source` with every `GIT_`-prefixed name removed.
 *
 * Removed by prefix rather than by a list of the ones measured to redirect, so that a variable nobody has
 * measured fails closed. Nothing in the command set needs a `GIT_` variable, which ADR-0029 measures, so
 * removing them all costs nothing — reintroducing a keep-list has to argue with that measurement.
 */
export function gitEnvironment(source: Readonly<Record<string, string | undefined>>): GitEnvironment {
	const env: Record<string, string> = {};
	const reportable: string[] = [];
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (!name.startsWith("GIT_")) env[name] = value;
		else if (!UNREPORTED_GIT_VARIABLES.has(name)) reportable.push(name);
	}
	return { env, reportable: reportable.sort() };
}

/** Whether this has been said already, so a redirected shell hears it once rather than once per command. */
let removalsReported = false;

function reportRemovals(names: readonly string[]): void {
	if (removalsReported || names.length === 0) return;
	removalsReported = true;
	const one = names.length === 1;
	// Not "nothing else changes, so unset them": a `GIT_CONFIG_COUNT` trio can carry a `safe.directory` grant
	// that is the only reason git works at all, and unsetting that removes the grant rather than the warning.
	process.stderr.write(
		`${names.join(", ")} ${one ? "was" : "were"} removed from the environment of every git command: this tool names the repository it means on each command, so an inherited GIT_ variable can only answer for a different one. Anything ${one ? "it" : "they"} configured is gone with ${one ? "it" : "them"}.\n`,
	);
}

export const defaultRunner: Runner = (argv) => {
	// `gh`, `glab` and `jira` cross this seam too and authenticate from the environment, so theirs is handed
	// over whole. ADR-0029.
	//
	// The final path segment rather than the whole word, so an absolute path is scrubbed too. ADR-0029 bounds
	// what that catches and what it does not.
	const git = argv[0]?.split("/").at(-1) === "git" ? gitEnvironment(process.env) : undefined;
	if (git) reportRemovals(git.reportable);
	try {
		// Bun reads `env: undefined` as "inherit", the same as omitting it, so one call covers both cases.
		const result = spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe", env: git?.env });
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (err) {
		return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
};
