import { DEFAULT_LABEL_FILTER, LabelFilterError, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import type { Runner } from "./runner";

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

const USAGE = `nextup — picks the ticket to start next, claims it, and says how to start work on it

No tracker adapter is wired yet: only --help and -h succeed, and every other invocation exits 2.

usage: nextup [--include <label>]... [--exclude <label>]... [--yes] [--json] [--print-command]

  --include <label>  consider only tickets carrying one of these labels; repeatable
  --exclude <label>  never consider a ticket carrying one of these labels; repeatable
  --yes              claim the pick without asking first
  --print-command    print the launch command and claim nothing
  --json             emit the selection as JSON rather than the human rendering
  --help, -h         print this

A label may end in "*" to match a prefix. --exclude 'wayfinder:*' always applies and --exclude adds
to it, so the two tracks cannot compete for one ticket on a flag that never mentioned wayfinder.

The filter narrows only what may be recommended: the blocking graph still reads every ticket, so an
excluded ticket still blocks.

The pick is shown and confirmed before it is claimed. --yes answers in advance, which is what an
unattended run needs; with neither a terminal nor --yes the run is refused rather than answered on
your behalf. --print-command claims nothing and never asks.

Exit status: 0 a ticket claimed, or a command printed, 1 nothing started — nothing to recommend, or
the pick declined, 2 something needing a person — no configured ticket-set source, a bad invocation, a
ticket set that will not read or take a claim, or a claim left behind, 3 a pick another run may find
free.
`;

export function run(argv: readonly string[], deps: CliDeps): CliResult {
	let options: Options;
	try {
		options = parse(argv);
	} catch (cause) {
		return usageError(cause);
	}
	if (options.help) return { code: 0, stdout: USAGE, stderr: "" };

	try {
		compileLabelFilter(options.filter);
	} catch (cause) {
		return usageError(cause);
	}

	return { code: 2, stdout: "", stderr: "no ticket-set source is configured\n" };
}

class CliError extends Error {}

interface Options {
	readonly help: boolean;
	readonly json: boolean;
	readonly yes: boolean;
	readonly printCommand: boolean;
	readonly filter: LabelFilterSpec;
}

function parse(argv: readonly string[]): Options {
	let help = false;
	let json = false;
	let yes = false;
	let printCommand = false;
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
	return { help, json, yes, printCommand, filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] } };
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
