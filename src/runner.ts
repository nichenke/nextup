import { spawnSync } from "bun";
import { constants } from "node:os";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (argv: string[]) => CommandResult;

/**
 * The exit code a shell reports for a child killed by `signal`, which is the convention every caller already
 * reads that way — 134 for `SIGABRT`, the code ADR-0029 measured `git worktree add` aborting with. Taken from
 * the platform's own table rather than a list here, so an unlisted signal cannot come out as a wrong number.
 */
function signalledExitCode(signal: string): number {
	const numbers: Record<string, number | undefined> = constants.signals;
	// 128 alone for a name the table does not hold: still non-zero, and the name itself reaches stderr.
	return 128 + (numbers[signal] ?? 0);
}

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
 * Removed by prefix rather than by a list of the ones measured to redirect, so an unmeasured variable cannot
 * point git anywhere. Nothing in the command set needs a `GIT_` variable, which ADR-0029 measures, so
 * reintroducing a keep-list has to argue with that measurement — as does treating this as closing anything
 * beyond redirection, which ADR-0029 bounds.
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
	// Says what the class can do, not what these names did: the whole prefix goes, and most of it was measured
	// as changing no answer. Deliberately no "unset them" advice — a removed variable may have carried the only
	// configuration that makes git work here. ADR-0029.
	process.stderr.write(
		`${names.join(", ")} ${one ? "was" : "were"} removed from the environment of every git command, because a GIT_ variable can answer for a repository this tool did not ask about and the whole class goes rather than a list of names. Anything ${one ? "it" : "they"} configured is gone with ${one ? "it" : "them"}.\n`,
	);
}

export const defaultRunner: Runner = (argv) => {
	// git only: `gh`, `glab` and `jira` cross this seam and authenticate from the environment. The final path
	// segment rather than the whole word, so an absolute path is scrubbed too. ADR-0029 bounds both.
	const scrubbed = argv[0]?.split("/").at(-1) === "git" ? gitEnvironment(process.env) : undefined;
	if (scrubbed) reportRemovals(scrubbed.reportable);
	try {
		// Always constructed, never inherited, so `argv[0]` decides only which names are removed. Inheriting
		// would also decide *when* the environment was read: Bun gives an inherited child the one it started
		// with, so the two kinds of child would disagree about a variable assigned since.
		const env = scrubbed?.env ?? { ...process.env };
		const result = spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe", env });
		// A child killed by a signal has no exit code, and `code` is a number: `worktree.ts` renders it into
		// the message a user reads, where `null` names nothing. The signal goes to stderr so neither is lost.
		const signal = result.signalCode;
		return {
			code: signal ? signalledExitCode(signal) : (result.exitCode ?? 0),
			stdout: result.stdout.toString(),
			stderr: signal ? `${result.stderr.toString()}killed by ${signal}\n` : result.stderr.toString(),
		};
	} catch (err) {
		return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
};
