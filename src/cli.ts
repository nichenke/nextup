import { GitHubAdapterError, isReadableLimit, readGitHubTicketSet } from "./github-adapter";
import {
	DEFAULT_LABEL_FILTER,
	type LabelFilter,
	LabelFilterError,
	type LabelFilterSpec,
	compileLabelFilter,
} from "./label-filter";
import type { Runner } from "./runner";
import { type Answer, answerJson, renderAnswer } from "./selection-output";
import { SelectionError, select } from "./selector";

/**
 * Prints `question` itself and reports the answer, because `run` returns its output rather than
 * writing it, so a question held until `run` returns would be asked after the moment it was about.
 */
export type Confirm = (question: string) => boolean;

export interface CliDeps {
	readonly runner: Runner;
	/** `null` where there is nobody to ask — a pipe, a cron entry, a sandbox with no terminal. */
	readonly confirm: Confirm | null;
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

const USAGE = `nextup — picks the ticket to start next, claims it, and says how to start work on it

Nothing writes yet: a run reads the GitHub repository the working directory's origin points at, reports
the pick, and claims nothing. --yes and --print-command are accepted and change nothing until the claim
and launch steps land.

usage: nextup [--include <label>]... [--exclude <label>]... [--limit <n>] [--yes] [--json]
              [--print-command]

  --include <label>  consider only tickets carrying one of these labels; repeatable
  --exclude <label>  never consider a ticket carrying one of these labels; repeatable
  --limit <n>        how many open tickets to consider; ${DEFAULT_LIMIT} by default
  --yes              claim the pick without asking first
  --print-command    print the launch command and claim nothing
  --json             emit the answer as JSON rather than the human rendering
  --help, -h         print this

A label may end in "*" to match a prefix. --exclude 'wayfinder:*' always applies and --exclude adds
to it, so the two tracks cannot compete for one ticket on a flag that never mentioned wayfinder.

The filter narrows only what may be recommended: the blocking graph still reads every ticket, so an
excluded ticket still blocks.

Once claiming lands: the pick will be shown and confirmed before it is claimed, --yes will answer in
advance for an unattended run, with neither a terminal nor --yes the run will be refused rather than
answered on your behalf, and --print-command will claim nothing and never ask. None of that is wired
yet — today every invocation prints the pick and stops.

Only open tickets are read, so the limit is spent on tickets a pick can come from. The window is the most
recently created of them, so a repository with more open tickets than the limit never considers its oldest
ones, and a read that hits the limit says so on a "degraded: " line. Raising --limit past your open count is
what widens that window; --include cannot, because it narrows what may be recommended from within whatever
was read. A tracker that could not be reached reports that same line beside its own, and there the answer is
to retry rather than to change anything.

Exit status, of what is wired: 0 a pick reported, 1 nothing to recommend, 2 something needing a person
— a repository that cannot be resolved, a read that is itself wrong, or a bad invocation. A tracker that
could not be reached is reported as a degraded answer with nothing to recommend, which is 1.
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

	// An outage arrives as a degrade rather than as a throw, so whether anything was picked is the whole
	// exit-status question: a tracker that could not be reached reports 1, not 2.
	return {
		code: answer.selection.pick === null ? 1 : 0,
		stdout: options.json ? `${JSON.stringify(answerJson(answer), null, "\t")}\n` : renderAnswer(answer),
		stderr: "",
	};
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
	readonly filter: LabelFilterSpec;
}

/**
 * The flags whose next word is a value rather than a flag. Must list exactly the cases below that call
 * `value`, because `asksForHelp` reads this to know which words are not flags at all.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--include", "--exclude", "--limit"]);

/**
 * Whether the line asks for help, answered before the rest of it is judged: help is what a person reaches
 * for *after* getting a flag wrong, and parsing first turned `nextup --limit --help` into a usage error.
 *
 * A word standing in as a flag's value is skipped, because `-h` is a label a repository may really carry and
 * `--include -h` is then a read rather than a request for help. `--help` in that position still asks for
 * help: `canBeValue` refuses it as a value, so no read could have used it either way.
 */
function asksForHelp(argv: readonly string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const word = argv[i]!;
		if (VALUE_FLAGS.has(word) && canBeValue(argv[i + 1])) {
			i++;
			continue;
		}
		if (word === "--help" || word === "-h") return true;
	}
	return false;
}

/** A flag's value is anything but another long flag, which is the rule `value` enforces. */
function canBeValue(word: string | undefined): word is string {
	return word !== undefined && !word.startsWith("--");
}

function parse(argv: readonly string[]): Options {
	let json = false;
	let yes = false;
	let printCommand = false;
	let limit = DEFAULT_LIMIT;
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

	// The default exclusion is a floor, not a starting point a filter flag replaces: `--include backend`
	// would otherwise hand out a wayfinder ticket labelled `backend`.
	return { json, yes, printCommand, limit, filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] } };
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
	const limit = /^[0-9]+$/.test(given) ? Number(given) : Number.NaN;
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
