import { resolve } from "node:path";
import { ClaimError, markdownClaimer } from "./claim";
import { CommandBuilderError, DEFAULT_SLASH_COMMAND, formatCommand } from "./command-builders";
import { type Launch, type LaunchPlan, LaunchError, planLaunch, prepareLaunch } from "./launcher";
import { MarkdownEffortError, type MarkdownTicket, discoverEfforts, readEffort } from "./markdown-adapter";
import { DEFAULT_LABEL_FILTER, LabelFilterError, type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import type { Runner } from "./runner";
import { renderSelection, selectionJson } from "./selection-output";
import { type Candidate, type Selection, SelectionError, select } from "./selector";
import { ticketId } from "./ticket";
import { formatTicketRef } from "./ticket-ref";

/**
 * Puts the pick to the person running this and reports what they said. It prints `question` itself,
 * because `run` returns its output rather than writing it and an answer given before the pick had been
 * shown would be an answer to nothing.
 */
export type Confirm = (question: string) => boolean;

export interface CliDeps {
	readonly cwd: string;
	/**
	 * The one seam every external process passes through. Markdown runs none, so nothing reaches it on
	 * this path yet; requiring it is what stops a tracker added later from shelling out through a
	 * default the caller never handed over.
	 */
	readonly runner: Runner;
	/**
	 * `null` where there is nobody to ask — a pipe, a cron entry, a sandbox with no terminal. Not an
	 * automatic yes: an unattended run that meant to claim says so with `--yes`, and one that did not
	 * is refused rather than answered on its behalf.
	 */
	readonly confirm: Confirm | null;
}

/**
 * What the command wrote and what it exited with, rather than the writing itself, so that the whole
 * command is assertable without capturing a process's streams.
 *
 * `1` separates "nothing was started" from `2`, "this invocation or this ticket set is wrong". A
 * caller polling for work needs to tell a quiet day from a broken one, and folding both into a single
 * non-zero code makes a misspelled flag look like an empty ticket set. Nothing to recommend and a pick
 * declined at the gate are both `1`: to a caller they are the same answer, that there is no session to
 * go to, and the rendering says which. `3` is the same argument again: a pick somebody else took is a
 * different answer from a ticket set that will not read, and only one of the two is worth coming back
 * to.
 */
export interface CliResult {
	readonly code: 0 | 1 | 2 | 3;
	readonly stdout: string;
	readonly stderr: string;
}

const USAGE = `nextup — picks the ticket to start next, claims it, and says how to start work on it

usage: nextup [--effort <path>] [--include <label>]... [--exclude <label>]... [--yes] [--json]
              [--print-command]

  --effort <path>    the effort to read; defaults to the single effort under <cwd>/.scratch
  --include <label>  consider only tickets carrying one of these labels; repeatable
  --exclude <label>  never consider a ticket carrying one of these labels; repeatable
  --yes              claim the pick without asking first
  --print-command    print the launch command and claim nothing
  --json             emit the selection as JSON rather than the human rendering
  --help             print this

A label may end in "*" to match a prefix. --exclude 'wayfinder:*' always applies and --exclude adds
to it, so the two tracks cannot compete for one ticket on a flag that never mentioned wayfinder.

The filter narrows only what may be recommended: the blocking graph still reads every ticket, so an
excluded ticket still blocks.

The pick is shown and confirmed before it is claimed. --yes answers in advance, which is what an
unattended run needs; with neither a terminal nor --yes the run is refused rather than answered on
your behalf. --print-command claims nothing and never asks.

Exit status: 0 a ticket claimed, 1 nothing started — nothing to recommend, or the pick declined,
2 a bad invocation or a ticket set that could not be read, 3 a pick that could not be claimed.
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
		// Resolved against the same root discovery uses, so a relative `--effort` cannot mean one
		// directory here and another in `soleEffort`.
		effort = readEffort(
			options.effort === null ? soleEffort(deps.cwd) : resolve(deps.cwd, options.effort),
			{ runner: deps.runner },
		);
	} catch (cause) {
		if (cause instanceof MarkdownEffortError || cause instanceof CliError) {
			return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		}
		throw cause;
	}

	let selection;
	try {
		selection = select({ tickets: effort.tickets, graph: effort.graph, filter, truncated: effort.truncated });
	} catch (cause) {
		if (cause instanceof SelectionError) return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}

	const pick = selection.pick;
	if (pick === null) return nothingToStart(options, selection);

	return options.printCommand
		? printCommand(options, selection, pick)
		: startWork(options, selection, pick, effort.tickets, deps);
}

function nothingToStart(options: Options, selection: Selection): CliResult {
	if (options.json) return { code: 1, stdout: json(selection, null), stderr: "" };
	const rendered = renderSelection(selection);
	return options.printCommand ? { code: 1, stdout: "", stderr: rendered } : { code: 1, stdout: rendered, stderr: "" };
}

/**
 * The pick and what would start work on it, with the tracker untouched. ADR-0002's bridge between the
 * two layers: the same plan the launcher runs, worked out where it is safe to work it out.
 */
function printCommand(options: Options, selection: Selection, pick: Candidate): CliResult {
	let plan;
	try {
		plan = planLaunch({ ref: pick.ref, slashCommand: DEFAULT_SLASH_COMMAND });
	} catch (cause) {
		if (cause instanceof CommandBuilderError) return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}
	if (options.json) return { code: 0, stdout: json(selection, plan), stderr: "" };
	// Why this ticket won goes to stderr, so stdout stays a command a caller can pipe into a shell
	// while a person running the same invocation still sees the reasoning.
	return { code: 0, stdout: `${formatCommand(plan.command)}\n`, stderr: renderSelection(selection) };
}

function startWork(
	options: Options,
	selection: Selection,
	pick: Candidate,
	tickets: readonly MarkdownTicket[],
	deps: CliDeps,
): CliResult {
	const id = ticketId(pick.ref);
	const ticket = tickets.find((candidate) => ticketId(candidate.ref) === id);
	if (ticket === undefined) {
		// The pick comes from these same tickets, so this is a corrupted invariant rather than an input
		// the user can fix — reported as a refusal instead of a claim written against a guessed file.
		return { code: 2, stdout: "", stderr: `${formatTicketRef(pick.ref)} is not in the effort it was picked from\n` };
	}

	// Refused rather than treated as a no: an unattended run that meant to claim is one flag away, and
	// silently declining every one of them would look exactly like an empty ticket set.
	const ask = deps.confirm;
	if (!options.yes && ask === null) {
		return { code: 2, stdout: "", stderr: "there is no terminal to confirm on; pass --yes to claim without asking\n" };
	}

	let launch;
	try {
		launch = prepareLaunch({
			ref: pick.ref,
			slashCommand: DEFAULT_SLASH_COMMAND,
			claimer: markdownClaimer(ticket, { runner: deps.runner }),
			// `ask` is null here only when --yes was given, which the guard above is what guarantees.
			confirm: options.yes || ask === null ? () => true : (plan) => ask(gate(selection, plan)),
		});
	} catch (cause) {
		// 2 and 3 split on whether a later run could do better. A ticket set that will not take a claim
		// stays wrong until somebody edits it, and so does a command that could not be built — which
		// claimed nothing at all, since the plan is made before the claim. An unavailable pick is the
		// other answer: the ticket was fine and somebody else had it. A stranded claim is 3 as well,
		// with something outstanding to go and clear.
		if (cause instanceof CommandBuilderError) return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		if (cause instanceof ClaimError) {
			return { code: cause.kind === "ticket-set" ? 2 : 3, stdout: "", stderr: `${message(cause)}\n` };
		}
		if (cause instanceof LaunchError) return { code: 3, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}

	if (launch === null) {
		// The gate printed the pick on its way to asking, so repeating it here would show it twice.
		const declined = `${formatTicketRef(pick.ref)} not claimed\n`;
		return options.json ? { code: 1, stdout: json(selection, null), stderr: "" } : { code: 1, stdout: declined, stderr: "" };
	}

	if (options.json) return { code: 0, stdout: json(selection, launch), stderr: "" };
	const claimed = `claimed ${formatTicketRef(launch.hold.ref)}\n`;
	// The gate printed the pick and the command on its way to asking, so an approved run reports only
	// what has changed since. --yes was never shown either, and gets the whole answer here.
	if (!options.yes) return { code: 0, stdout: claimed, stderr: "" };
	return {
		code: 0,
		stdout: `${renderSelection(selection)}${claimed}would run: ${formatCommand(launch.command)}\n`,
		stderr: "",
	};
}

/** What the gate shows before it asks: the pick, why it won, and exactly what approving it runs. */
function gate(selection: Selection, plan: LaunchPlan): string {
	return `${renderSelection(selection)}would run: ${formatCommand(plan.command)}\nclaim it and start work? [y/N]`;
}

/**
 * The selection document, plus what this invocation did about it. `claimed` is read off the plan rather
 * than passed alongside it, so the flag cannot say a claim was taken on a path that took none. Both
 * keys are always present, so a consumer can read either without first testing whether it is there.
 */
function json(selection: Selection, plan: LaunchPlan | Launch | null): string {
	const claimed = plan !== null && "hold" in plan;
	return `${JSON.stringify({ ...selectionJson(selection), claimed, command: plan?.command ?? null }, null, "\t")}\n`;
}

class CliError extends Error {}

interface Options {
	readonly help: boolean;
	readonly json: boolean;
	readonly yes: boolean;
	readonly printCommand: boolean;
	readonly effort: string | null;
	readonly filter: LabelFilterSpec;
}

function parse(argv: readonly string[]): Options {
	let help = false;
	let json = false;
	let yes = false;
	let printCommand = false;
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
			case "--yes":
				yes = true;
				break;
			case "--print-command":
				printCommand = true;
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

	// The default exclusion is a floor, not a starting point a filter flag replaces: `--include backend`
	// would otherwise hand out a wayfinder ticket labelled `backend`.
	return { help, json, yes, printCommand, effort, filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] } };
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
