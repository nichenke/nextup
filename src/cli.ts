import { CommandBuilderError, DEFAULT_SLASH_COMMAND, formatCommand } from "./command-builders";
import { GitHubAdapterError, isReadableLimit, readGitHubTicketSet } from "./github-adapter";
import { GitHubClaimError, claimGitHubTicket } from "./github-claim";
import {
	DEFAULT_LABEL_FILTER,
	type LabelFilter,
	LabelFilterError,
	type LabelFilterSpec,
	compileLabelFilter,
} from "./label-filter";
import { LaunchError, launch, planLaunch, requireWorkspaceHost } from "./launcher";
import type { Runner } from "./runner";
import { type Answer, answerJson, renderAnswer } from "./selection-output";
import { type Candidate, SelectionError, select } from "./selector";
import { type TicketRef, formatTicketRef } from "./ticket-ref";
import { WorktreeError, type WorktreeOutcome, ensure } from "./worktree";
import { renderWorktree } from "./worktree-output";

/**
 * Prints `question` itself and reports the answer, because `run` returns its output rather than
 * writing it, so a question held until `run` returns would be asked after the moment it was about.
 */
export type Confirm = (question: string) => boolean;

export interface CliDeps {
	readonly runner: Runner;
	/** `null` where there is nobody to ask — a pipe, a cron entry, a sandbox with no terminal. */
	readonly confirm: Confirm | null;
	/**
	 * The checkout the command was invoked in, which the worktree step resolves the primary one from. The
	 * read finds its repository through `origin` instead, so this is the one place a filesystem path is
	 * needed and it is passed rather than taken from the process, so a test can name somewhere it is not.
	 */
	readonly cwd: string;
}

/**
 * What the command wrote and what it exited with, rather than the writing itself, so that the whole
 * command is assertable without capturing a process's streams.
 */
export interface CliResult {
	readonly code: 0 | 1 | 2;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * How many open tickets one run considers when nothing says otherwise; ADR-0028 has what that claims, and
 * why it is one below the round number rather than on it.
 */
export const DEFAULT_LIMIT = 199;

const USAGE = `nextup — picks the ticket to start next, claims it, and starts a session working on it

A run reads the GitHub repository the working directory's origin points at, ranks what is startable, and
shows you the pick. Once you agree, it makes the ticket's worktree, claims the ticket, and starts a
session on it in that worktree.

usage: nextup [--include <label>]... [--exclude <label>]... [--limit <n>] [--slash-command </verb>]
              [--yes] [--json] [--print-command]

  --include <label>        consider only tickets carrying one of these labels; repeatable
  --exclude <label>        never consider a ticket carrying one of these labels; repeatable
  --limit <n>              how many open tickets to consider; ${DEFAULT_LIMIT} by default
  --slash-command </verb>  what the started session runs; ${DEFAULT_SLASH_COMMAND} by default, so the same
                           command can start an implementation, a triage, or a research session
  --yes                    start the pick without asking first
  --print-command          print the session command, and start, claim and create nothing
  --json                   emit the answer as JSON rather than the human rendering
  --help, -h               print this

A label may end in "*" to match a prefix. These exclusions always apply and --exclude adds to them
rather than replacing them: 'wayfinder:*', so the planning and delivery tracks cannot compete for
one ticket; 'needs-triage', because an untriaged ticket is a wrong answer rather than a lower-ranked
one; and 'spec', so a run never recommends starting work on the specification its own tickets were
cut from. Excluding a label a repository does not use costs nothing.

The filter narrows only what may be recommended: the blocking graph still reads every ticket, so an
excluded ticket still blocks.

Tickets that block each other in a loop are named on a "deadlock: " line, which is the sentinel for
the one thing no rerun improves: a ticket set that is merely blocked opens up when its blockers close,
and one holding a cycle does not until a person breaks it.

Starting work writes in three places, in this order: the ticket's worktree, then the claim, then the
session. Nothing unwinds. A step that fails leaves what the steps before it did, and running the command
again continues from there rather than starting over — so the leftover of a failure is a directory you
can see rather than your name parked on work nobody is doing.

The confirmation gate is on by default, and names the pick as it asks. --yes answers it in advance for an
unattended run. With neither a terminal to ask on nor --yes, the run is refused rather than answered on
your behalf. --print-command never asks, because it starts nothing.

There is no fallback when the workspace host is not running. The run is refused, and refused before the
worktree and the claim, so nothing is left behind for a session that was never going to start. Start the
host and run again, or use --print-command and start the session yourself.

Only open tickets are read, so the limit is spent on tickets a pick can come from. The window is the most
recently created of them, so a repository with more open tickets than the limit never considers its oldest
ones, and a read that hits the limit says so on a "degraded: " line. Raising --limit past your open count is
what widens that window; --include cannot, because it narrows what may be recommended from within whatever
was read. A tracker that could not be reached reports that same line beside its own, and there the answer is
to retry rather than to change anything.

Exit status: 0 the command did what was asked — a session started, a command printed, or a pick you were
shown and declined; 1 nothing to recommend; 2 something needing a person — a repository that cannot be
resolved, a read that is itself wrong, a bad invocation, no way to confirm and no --yes, a workspace host
that is not running, a worktree that cannot be made, or a claim that would not land. A tracker that could
not be reached is reported as a degraded answer with nothing to recommend, which is 1.

Declining is 0 rather than a status of its own, because the gate did its job. A script that needs to know
whether a session started passes --yes, which never declines, and reads the "start" object under --json.

A deadlock never decides the status. Whether the answer is 0 or 1 is only whether there was a pick, so a
cycle reported beside one is still 0, and a set with nothing to recommend is 1 whether its candidates are
merely blocked or deadlocked. A wrapper deciding whether to retry has to read the "deadlock: " lines.
`;

export function run(argv: readonly string[], deps: CliDeps): CliResult {
	if (asksForHelp(argv)) return { code: 0, stdout: USAGE, stderr: "" };

	let options: Options;
	try {
		options = parse(argv);
	} catch (cause) {
		return usageError(cause);
	}

	let filter: LabelFilter;
	try {
		filter = compileLabelFilter(options.filter);
	} catch (cause) {
		return usageError(cause);
	}

	let answer: Answer;
	try {
		const read = readGitHubTicketSet({ runner: deps.runner, limit: options.limit });
		const selection = select({
			tickets: read.tickets,
			graph: read.graph,
			truncated: read.truncated,
			openOnly: read.openOnly,
			filter,
		});
		answer = { selection, readDegraded: read.degraded };
	} catch (cause) {
		return failedAnswer(cause);
	}

	let start: StartOutcome;
	try {
		start = startWork(answer.selection.pick, options, deps);
	} catch (cause) {
		return failedStart(cause);
	}

	// An outage arrives as a degrade rather than as a throw, so whether anything was picked is the whole
	// exit-status question: a tracker that could not be reached reports 1, not 2.
	return {
		code: start.kind === "nothing-to-start" ? 1 : 0,
		stdout: options.json
			? `${JSON.stringify({ ...answerJson(answer), start: startJson(start) }, null, "\t")}\n`
			: `${renderAnswer(answer)}${renderStart(start)}`,
		stderr: "",
	};
}

/**
 * What the run did about the pick it had. A union rather than flags on one shape, so the two outcomes that
 * wrote nothing cannot be confused with the one that wrote three things — and so the JSON form below has to
 * name every arm rather than carry a nullable worktree that means two different absences.
 */
export type StartOutcome =
	| { readonly kind: "nothing-to-start" }
	| { readonly kind: "printed"; readonly command: readonly string[] }
	| { readonly kind: "declined"; readonly ref: TicketRef }
	| {
			readonly kind: "started";
			readonly ref: TicketRef;
			readonly worktree: WorktreeOutcome;
			readonly command: readonly string[];
			readonly workspace: readonly string[];
	  };

/**
 * Starting work on the pick: the workspace host first, then the gate, then the worktree, the claim and the
 * session.
 *
 * The host is asked before anything is written and the gate is asked before that too, so the two refusals a
 * person meets most often both leave the repository and the tracker as they were. ADR-0016 fixes the order
 * of the three writes and requires that nothing here unwinds any of them.
 *
 * @throws StartError where there is nobody to confirm with, and where a step after the worktree failed —
 * carrying the worktree, so the abort says what re-running would continue from.
 * @throws WorktreeError, GitHubClaimError, LaunchError from the steps themselves.
 */
function startWork(pick: Candidate | null, options: Options, deps: CliDeps): StartOutcome {
	if (pick === null) return { kind: "nothing-to-start" };
	if (options.printCommand) {
		return { kind: "printed", command: planLaunch({ ref: pick.ref, slashCommand: options.slashCommand }).command };
	}

	requireWorkspaceHost(deps.runner);
	if (!approved(pick, options, deps)) return { kind: "declined", ref: pick.ref };

	const worktree = ensure({ runner: deps.runner, repo: deps.cwd, ticket: pick });
	try {
		claimGitHubTicket({ runner: deps.runner, ref: pick.ref });
		const started = launch({
			runner: deps.runner,
			ref: pick.ref,
			slashCommand: options.slashCommand,
			worktree: worktree.path,
		});
		return { kind: "started", ref: pick.ref, worktree, command: started.command, workspace: started.workspace };
	} catch (cause) {
		throw startedNothing(cause, worktree);
	}
}

/**
 * Whether to go ahead. `--yes` answers in advance; otherwise the person at the terminal is asked, and the
 * question names the pick because `run` returns its output rather than writing it, so the rendering the
 * question is about has not been printed yet.
 *
 * @throws StartError where there is nobody to ask. Refused rather than assumed in either direction: assuming
 * yes claims a ticket and starts a session nobody saw, and assuming no makes an unattended run a silent
 * no-op that still reports success.
 */
function approved(pick: Candidate, options: Options, deps: CliDeps): boolean {
	if (options.yes) return true;
	if (deps.confirm === null) {
		throw new StartError(
			"there is no terminal to confirm on, so nothing was started — pass --yes to answer in advance, or --print-command to get the command without starting anything",
		);
	}
	return deps.confirm(`start ${formatTicketRef(pick.ref)} — ${pick.title} — in its own worktree, claiming it first? [y/N]`);
}

/** Why the run started nothing, where that is a thing for a person rather than a mistake on the command line. */
class StartError extends Error {}

/**
 * A failure after the worktree was made, told with the worktree beside it.
 *
 * ADR-0016 makes re-running the recovery path rather than a separate one, and an operator who is not told a
 * worktree is already there has no reason to believe that. A failure of a class nobody has classified is
 * returned untouched instead, because wrapping it would cost the stack that is all it has.
 */
function startedNothing(cause: unknown, worktree: WorktreeOutcome): unknown {
	if (!(cause instanceof GitHubClaimError || cause instanceof LaunchError || cause instanceof CommandBuilderError)) {
		return cause;
	}
	return new StartError(
		`${cause.message}\n${worktree.path} is in place on ${worktree.branch}, so running this again continues from there rather than starting over.`,
	);
}

/**
 * Whatever refused to start the work, as something for a person to fix. Every class here is a refusal this
 * code wrote, so the message is the whole report; anything else keeps its stack, for the reason
 * `failedAnswer` gives.
 */
function failedStart(cause: unknown): CliResult {
	if (
		cause instanceof StartError ||
		cause instanceof WorktreeError ||
		cause instanceof GitHubClaimError ||
		cause instanceof LaunchError
	) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n` };
	}
	return failedAnswer(cause);
}

function renderStart(start: StartOutcome): string {
	switch (start.kind) {
		case "nothing-to-start":
			return "";
		case "printed":
			return `${formatCommand(start.command)}\n`;
		case "declined":
			return `${formatTicketRef(start.ref)} was not started, and nothing was claimed or created.\n`;
		case "started":
			return `${renderWorktree(start.worktree)}claimed ${formatTicketRef(start.ref)}\nstarted ${formatCommand(start.command)}\n`;
	}
}

/** `StartOutcome` with every reference in the short form `CandidateJson` uses. */
export type StartOutcomeJson =
	| Extract<StartOutcome, { readonly kind: "nothing-to-start" | "printed" }>
	| (Omit<Extract<StartOutcome, { readonly kind: "declined" }>, "ref"> & { readonly ref: string })
	| (Omit<Extract<StartOutcome, { readonly kind: "started" }>, "ref"> & { readonly ref: string });

function startJson(start: StartOutcome): StartOutcomeJson {
	switch (start.kind) {
		case "nothing-to-start":
		case "printed":
			return start;
		case "declined":
		case "started":
			return { ...start, ref: formatTicketRef(start.ref) };
	}
}

/**
 * Whatever a read or the selection over it refused, as something for a person to fix — including a failure
 * of neither class, which is the case that has to be loud rather than rethrown. An uncaught throw leaves
 * exit 1, which this command defines as nothing to recommend, so a run that failed would reach a script as a
 * quiet day. Unrecognised, it keeps its stack: nobody has classified it, so whoever reads it needs everything.
 */
function failedAnswer(cause: unknown): CliResult {
	if (cause instanceof GitHubAdapterError || cause instanceof SelectionError) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n` };
	}
	return { code: 2, stdout: "", stderr: `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n` };
}

class CliError extends Error {}

interface Options {
	readonly json: boolean;
	readonly yes: boolean;
	readonly printCommand: boolean;
	readonly limit: number;
	readonly slashCommand: string;
	readonly filter: LabelFilterSpec;
}

/**
 * What each value-taking flag could actually use as its value, asked per flag rather than in general: a label
 * may be spelled almost anything, including `-h`, while a limit is only ever digits. Must hold exactly the
 * cases below that call `value`.
 */
const VALUE_FLAGS: ReadonlyMap<string, (word: string) => boolean> = new Map([
	["--include", canBeValue],
	["--exclude", canBeValue],
	["--limit", isTicketCount],
	["--slash-command", isSlashCommand],
]);

/**
 * Whether the line asks for help, answered before the rest of it is judged: help is what a person reaches
 * for *after* getting a flag wrong, so `nextup --limit --help` must not come back a usage error.
 *
 * A word the preceding flag could really use is skipped, so `--include -h` is a read of a repository whose
 * label is spelled `-h`. The question is per flag and not just "is this a flag": `-h` cannot be a limit, so
 * `--limit -h` is a help request beside a mistyped value rather than a value.
 */
function asksForHelp(argv: readonly string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const word = argv[i]!;
		const usable = VALUE_FLAGS.get(word);
		const next = argv[i + 1];
		if (usable !== undefined && next !== undefined && usable(next)) {
			i++;
			continue;
		}
		if (word === "--help" || word === "-h") return true;
	}
	return false;
}

function canBeValue(word: string | undefined): word is string {
	return word !== undefined && !word.startsWith("--");
}

/** Digits only, which is what `tickets` accepts, so the two cannot disagree about what a limit looks like. */
function isTicketCount(word: string): boolean {
	return /^[0-9]+$/.test(word);
}

/**
 * A slash command: `/` and one word, which is what `sessionCommand` accepts. Asked here so that a mistyped
 * value reads as a bad invocation with the usage beside it, rather than as a builder failure with a stack —
 * and so `--slash-command -h` is the help request it looks like rather than a value.
 */
function isSlashCommand(word: string): boolean {
	return /^\/\S+$/.test(word);
}

function parse(argv: readonly string[]): Options {
	let json = false;
	let yes = false;
	let printCommand = false;
	let limit = DEFAULT_LIMIT;
	let slashCommand = DEFAULT_SLASH_COMMAND;
	const include: string[] = [];
	const exclude: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		switch (flag) {
			case "--json":
				json = true;
				break;
			case "--yes":
				yes = true;
				break;
			case "--print-command":
				printCommand = true;
				break;
			case "--limit":
				limit = tickets(value(argv, ++i, flag), flag);
				break;
			case "--slash-command":
				slashCommand = verb(value(argv, ++i, flag), flag);
				break;
			case "--include":
				include.push(value(argv, ++i, flag));
				break;
			case "--exclude":
				exclude.push(value(argv, ++i, flag));
				break;
			default:
				throw new CliError(`${flag} is not a flag this command takes`);
		}
	}

	// Prepended rather than replaced, so the defaults are a floor a filter flag cannot lift; ADR-0031 has why.
	return {
		json,
		yes,
		printCommand,
		limit,
		slashCommand,
		filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] },
	};
}

/** @throws CliError where the value is not a slash command a session could be given. */
function verb(given: string, flag: string): string {
	if (!isSlashCommand(given)) {
		throw new CliError(`${flag} takes "/" and one word, and ${given} is not that`);
	}
	return given;
}

/**
 * A count of tickets to read, refused here so that a mistyped flag reads as a bad invocation with the usage
 * beside it rather than as a tracker read that would not run.
 *
 * What this adds is the string: decimal digits rather than whatever `Number` accepts, which reads `0x10` as
 * sixteen and `1e3` as a thousand — a flag and the rows it asks for would be different numbers with nothing
 * saying so.
 */
function tickets(given: string, flag: string): number {
	const limit = isTicketCount(given) ? Number(given) : Number.NaN;
	if (!isReadableLimit(limit)) {
		throw new CliError(`${flag} takes a whole number of tickets above zero, and ${given} is not one`);
	}
	return limit;
}

function value(argv: readonly string[], index: number, flag: string): string {
	const given = argv[index];
	if (!canBeValue(given)) {
		throw new CliError(`${flag} needs a value`);
	}
	return given;
}

function usageError(cause: unknown): CliResult {
	if (cause instanceof CliError || cause instanceof LabelFilterError) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n\n${USAGE}` };
	}
	throw cause;
}
