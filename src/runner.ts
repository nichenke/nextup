import { spawnSync } from "bun";
import { constants } from "node:os";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (argv: string[]) => CommandResult;

/**
 * Stands in for an outcome that cannot be classified. Neither 0 nor 1: `branchExists` in `worktree.ts` reads
 * those two as answers — present, absent — and throws on everything else, which is where an unclassifiable
 * result belongs. 128 is also the floor a shell reports for a death by signal.
 */
const UNCLASSIFIED = 128;

/**
 * The exit code a shell reports for a child killed by `signal` — 134 for `SIGABRT`, the code ADR-0029 measured
 * `git worktree add` aborting with. Taken from the platform's own table rather than a list here, so an unlisted
 * signal cannot come out as a wrong number.
 *
 * Callers here compare against 0, with one exception that decides what the fallback may be: `branchExists` in
 * `worktree.ts` reads 1 as "the branch is not there" and throws on anything else. So a signal death must never
 * arrive as 1, which would answer a question instead of failing.
 */
function signalledExitCode(signal: string): number {
	const numbers: Record<string, number | undefined> = constants.signals;
	const number = numbers[signal];
	return number === undefined ? UNCLASSIFIED : 128 + number;
}

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

export class RunnerError extends Error {}

/**
 * The one `gh` variable that chooses which server a command reaches. `gh` documents it as supplying the hostname
 * "for commands where a hostname has not been provided", and every command this tool issues leaves the host off.
 */
const REDIRECTING_GH_VARIABLE = "GH_HOST";

/**
 * Refuses a `gh` command when the environment names a host for it.
 *
 * Refused rather than accommodated, because GitHub Enterprise is out of scope: the read adapter already turns away
 * an origin remote on any other host, so a set `GH_HOST` is either redundant or points somewhere this tool does not
 * work. Accommodating it instead means carrying a host into every repository argument — the preflight, the reads,
 * the write, the release and its verification — and one missed call site puts a write on the wrong server at exit 0.
 *
 * Refused whatever it names, including GitHub's own host. Comparing it would need `isGitHubHost`, which lives with
 * the reference types that import this module, so the check would have to move away from the seam it protects to
 * buy a value nothing here needs.
 *
 * `GH_REPO` is the other variable that could redirect and does not: an explicit `--repo` overrides it, measured on
 * gh 2.100.0, and every command this tool issues passes one. `GH_CONFIG_DIR` is not covered — it selects a config
 * whose default host this cannot see — so this closes the documented redirect, not every conceivable one.
 *
 * @throws RunnerError when the command is `gh` and the variable is set to anything.
 */
export function refuseRedirectedGitHub(argv: readonly string[], source: Readonly<Record<string, string | undefined>>): void {
	if (argv[0]?.split("/").at(-1) !== "gh") return;
	const named = source[REDIRECTING_GH_VARIABLE];
	if (named === undefined || named === "") return;
	throw new RunnerError(
		`${REDIRECTING_GH_VARIABLE} is set to ${named}, and this tool works on GitHub's own host only — unset it for this command rather than letting it decide which server the tool reads and writes.`,
	);
}

export const defaultRunner: Runner = (argv) => {
	refuseRedirectedGitHub(argv, process.env);
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
		// A child killed by a signal has no exit code, and `code` is a number callers switch on — `branchExists`
		// turns it into a boolean. The signal goes to stderr, so what killed the command is not lost either.
		const signal = result.signalCode;
		return {
			code: signal ? signalledExitCode(signal) : (result.exitCode ?? UNCLASSIFIED),
			stdout: result.stdout.toString(),
			stderr: signal ? `${result.stderr.toString()}killed by ${signal}\n` : result.stderr.toString(),
		};
	} catch (err) {
		return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
};
