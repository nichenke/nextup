import { GitHubAdapterError, readGitHubTicketSet } from "./github-adapter";
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
	readonly cwd: string;
	readonly runner: Runner;
	/** `null` where there is nobody to ask — a pipe, a cron entry, a sandbox with no terminal. */
	readonly confirm: Confirm | null;
}

/**
 * What the command wrote and what it exited with, rather than the writing itself, so that the whole
 * command is assertable without capturing a process's streams.
 */
export interface CliResult {
	readonly code: 0 | 1 | 2 | 3;
	readonly stdout: string;
	readonly stderr: string;
}

/** How many open tickets one run considers when nothing says otherwise; ADR-0028 has what that claims. */
export const DEFAULT_LIMIT = 200;

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

The pick is shown and confirmed before it is claimed. --yes answers in advance, which is what an
unattended run needs; with neither a terminal nor --yes the run is refused rather than answered on
your behalf. --print-command claims nothing and never asks.

Only open tickets are read, so the limit is spent on tickets a pick can come from. A read that hits the
limit says so on a "degraded: " line: narrow it with --include rather than raising it, since a longer
read costs more and still answers from whatever the tracker returned first.

Exit status, of what is wired: 0 a pick reported, 1 nothing to recommend, 2 something needing a person
— a repository that cannot be resolved, a read that is itself wrong, or a bad invocation. A tracker that
could not be reached is reported as a degraded answer with nothing to recommend, which is 1.
`;

export function run(argv: readonly string[], deps: CliDeps): CliResult {
	let options: Options;
	try {
		options = parse(argv);
	} catch (cause) {
		return usageError(cause);
	}
	if (options.help) return { code: 0, stdout: USAGE, stderr: "" };

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
		return readError(cause);
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
 * Whatever a read or the selection over it refused, as something for a person to fix. Anything else is left
 * to surface as a crash, which is why the read converts even a failure raised beneath it into one of these
 * two classes: an unclassifiable throw exits 1, and this command defines 1 as nothing to recommend.
 */
function readError(cause: unknown): CliResult {
	if (cause instanceof GitHubAdapterError || cause instanceof SelectionError) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n` };
	}
	throw cause;
}

class CliError extends Error {}

interface Options {
	readonly help: boolean;
	readonly json: boolean;
	readonly yes: boolean;
	readonly printCommand: boolean;
	readonly limit: number;
	readonly filter: LabelFilterSpec;
}

function parse(argv: readonly string[]): Options {
	let help = false;
	let json = false;
	let yes = false;
	let printCommand = false;
	let limit = DEFAULT_LIMIT;
	const include: string[] = [];
	const exclude: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		switch (flag) {
			case "--help":
			case "-h":
				help = true;
				break;
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
	return { help, json, yes, printCommand, limit, filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] } };
}

/**
 * A count of tickets to read. Refused here rather than by the adapter, so that a mistyped flag reads as a
 * bad invocation with the usage beside it rather than as a tracker read that would not run — which means
 * this has to refuse everything the adapter would, including the count whose over-fetched row would leave
 * the safe-integer range.
 *
 * Decimal digits rather than whatever `Number` accepts: it reads `0x10` as sixteen and `1e3` as a
 * thousand, so a flag and the rows it asks for would be different numbers with nothing saying so.
 */
function tickets(given: string, flag: string): number {
	const limit = /^[0-9]+$/.test(given) ? Number(given) : Number.NaN;
	if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(limit + 1)) {
		throw new CliError(`${flag} takes a whole number of tickets above zero, and ${given} is not one`);
	}
	return limit;
}

function value(argv: readonly string[], index: number, flag: string): string {
	const given = argv[index];
	if (given === undefined || given.startsWith("--")) {
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
