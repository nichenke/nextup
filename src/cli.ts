import { MarkdownEffortError, discoverEfforts, readEffort } from "./markdown-adapter";
import { DEFAULT_LABEL_FILTER, LabelFilterError, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import { renderSelection, selectionJson } from "./selection-output";
import { SelectionError, select } from "./selector";

export interface CliDeps {
	readonly cwd: string;
}

/**
 * What the command wrote and what it exited with, rather than the writing itself, so that the whole
 * command is assertable without capturing a process's streams.
 *
 * `1` separates "nothing to recommend" from `2`, "this invocation or this ticket set is wrong". A
 * caller polling for work needs to tell an empty backlog from a broken one, and folding both into a
 * single non-zero code makes a misspelled flag look like a quiet day.
 */
export interface CliResult {
	readonly code: 0 | 1 | 2;
	readonly stdout: string;
	readonly stderr: string;
}

const USAGE = `nextup — picks the ticket to start next, and says why

usage: nextup [--effort <path>] [--include <label>]... [--exclude <label>]... [--json]

  --effort <path>    the effort to read; defaults to the single effort under <cwd>/.scratch
  --include <label>  consider only tickets carrying one of these labels; repeatable
  --exclude <label>  never consider a ticket carrying one of these labels; repeatable
  --json             emit the selection as JSON rather than the human rendering
  --help             print this

A label may end in "*" to match a prefix. Naming either filter replaces the default, which is
--exclude 'wayfinder:*' — so --include 'wayfinder:*' drives the wayfinder track instead of the
backlog. Either way the filter narrows only what may be recommended: the blocking graph still reads
every ticket, so an excluded ticket still blocks.

Exit status: 0 a ticket to start, 1 nothing to recommend, 2 a bad invocation or a ticket set that
could not be read. This command only reads — it claims nothing and changes nothing.
`;

export function run(argv: readonly string[], deps: CliDeps): CliResult {
	let options: Options;
	try {
		options = parse(argv);
	} catch (cause) {
		return usageError(cause);
	}
	if (options.help) return { code: 0, stdout: USAGE, stderr: "" };

	let filter;
	try {
		filter = compileLabelFilter(options.filter);
	} catch (cause) {
		return usageError(cause);
	}

	let effort;
	try {
		effort = readEffort(options.effort ?? soleEffort(deps.cwd));
	} catch (cause) {
		if (cause instanceof MarkdownEffortError || cause instanceof CliError) {
			return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		}
		throw cause;
	}

	let selection;
	try {
		// Markdown reads a whole effort directory, so there is no page limit to stop short of.
		selection = select({ tickets: effort.tickets, graph: effort.graph, filter, truncated: false });
	} catch (cause) {
		if (cause instanceof SelectionError) return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}

	const stdout = options.json ? `${JSON.stringify(selectionJson(selection), null, "\t")}\n` : renderSelection(selection);
	return { code: selection.pick === null ? 1 : 0, stdout, stderr: "" };
}

class CliError extends Error {}

interface Options {
	readonly help: boolean;
	readonly json: boolean;
	readonly effort: string | null;
	readonly filter: LabelFilterSpec;
}

function parse(argv: readonly string[]): Options {
	let help = false;
	let json = false;
	let effort: string | null = null;
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
			case "--effort":
				effort = value(argv, ++i, flag);
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

	// Naming either list replaces the default rather than adding to it. Merging instead would make the
	// default a floor, and `--include 'wayfinder:*'` would then be cancelled by the very exclusion it
	// is trying to invert.
	const named = include.length > 0 || exclude.length > 0;
	return { help, json, effort, filter: named ? { include, exclude } : DEFAULT_LABEL_FILTER };
}

function value(argv: readonly string[], index: number, flag: string): string {
	const given = argv[index];
	if (given === undefined || given.startsWith("--")) {
		throw new CliError(`${flag} needs a value`);
	}
	return given;
}

/**
 * The one effort under `.scratch`, or a refusal. Choosing among several would be a decision made on
 * directory order, which is the non-determinism the fixed ladder exists to remove — so the refusal
 * names them and hands the choice back.
 */
function soleEffort(cwd: string): string {
	const efforts = discoverEfforts(cwd);
	const only = efforts[0];
	if (only === undefined) {
		throw new CliError(`no effort found under ${cwd}/.scratch; name one with --effort`);
	}
	if (efforts.length > 1) {
		throw new CliError(`several efforts are under ${cwd}/.scratch; name one with --effort:\n  ${efforts.join("\n  ")}`);
	}
	return only;
}

function usageError(cause: unknown): CliResult {
	if (cause instanceof CliError || cause instanceof LabelFilterError) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n\n${USAGE}` };
	}
	throw cause;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
