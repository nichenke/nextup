import { resolve } from "node:path";
import { ClaimError, markdownClaimer } from "./claim";
import { CommandBuilderError, DEFAULT_SLASH_COMMAND, formatCommand } from "./command-builders";
import { type LaunchOutcome, type LaunchPlan, LaunchError, planLaunch, prepareLaunch } from "./launcher";
import { MarkdownEffortError, type MarkdownTicket, discoverEfforts, readEffort } from "./markdown-adapter";
import {
	DEFAULT_LABEL_FILTER,
	LabelFilterError,
	type LabelFilter,
	type LabelFilterSpec,
	compileLabelFilter,
} from "./label-filter";
import type { Runner } from "./runner";
import { renderSelection, selectionJson } from "./selection-output";
import { type Candidate, type Selection, SelectionError, select } from "./selector";
import { ticketId } from "./ticket";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

/**
 * Puts the pick to the person running this and reports what they said. It prints `question` itself,
 * because `run` returns its output rather than writing it and an answer given before the pick had been
 * shown would be an answer to nothing.
 */
export type Confirm = (question: string) => boolean;

/** A gate that could not be put, which is not a gate that said no. Uncaught, this exited as one. */
class ConfirmError extends Error {}

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
 * go to, and the rendering says which. `3` is the same argument again, and `CLAIM_FAILURE_STATUS` is
 * where the line falls: only a pick another run may find free is worth coming back to.
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

Exit status: 0 a ticket claimed, or a command printed, 1 nothing started — nothing to recommend, or
the pick declined, 2 something needing a person — a bad invocation, a ticket set that will not read or
take a claim, or a claim left behind, 3 a pick another run may find free.
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
		: startWork(options, selection, pick, effort.tickets, deps, effort.root, filter);
}

function nothingToStart(options: Options, selection: Selection): CliResult {
	if (options.json) return { code: 1, stdout: json(selection, null), stderr: "" };
	const rendered = renderSelection(selection);
	return options.printCommand ? { code: 1, stdout: "", stderr: rendered } : { code: 1, stdout: rendered, stderr: "" };
}

/** The pick and what would start work on it, with the tracker untouched; see `planLaunch`. */
function printCommand(options: Options, selection: Selection, pick: Candidate): CliResult {
	let plan;
	try {
		plan = planLaunch({ ref: pick.ref, slashCommand: DEFAULT_SLASH_COMMAND });
	} catch (cause) {
		if (cause instanceof CommandBuilderError) return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}
	if (options.json) return { code: 0, stdout: json(selection, { kind: "planned", plan }), stderr: "" };
	// Why this ticket won goes to stderr, so stdout stays a command a caller can pipe into a shell
	// while a person running the same invocation still sees the reasoning.
	return { code: 0, stdout: `${formatCommand(plan.command)}\n`, stderr: renderSelection(selection) };
}

/**
 * Refuses where the pick is no longer the ticket this tool would start.
 *
 * By running the selection again against the re-read effort, rather than by testing the conditions
 * that seemed to matter. Every rule about what is startable already lives in `select`, and a second
 * set here would be a second answer to the same question — the first draft of this checked only for a
 * confirmed-blocked pick, and so let through a pick that had gone `unknown` while another candidate
 * stayed confirmed-unblocked, which ADR-0003's partition says wins outright.
 *
 * The gate is why this is needed at all: selection and the claim used to be microseconds apart, and a
 * question put to a person holds them however long an answer takes.
 *
 * @throws ClaimError, so a pick the ticket set moved out from under reports as one another run may
 * find free.
 */
function stillStartable(effortRoot: string, ref: TicketRef, filter: LabelFilter, deps: CliDeps): void {
	let current;
	try {
		current = readEffort(effortRoot, { runner: deps.runner });
	} catch (cause) {
		throw new ClaimError(`${effortRoot} could not be read again before claiming: ${message(cause)}`, "ticket-set", {
			cause,
		});
	}

	let now;
	try {
		now = select({ tickets: current.tickets, graph: current.graph, filter, truncated: current.truncated });
	} catch (cause) {
		throw new ClaimError(`${effortRoot} could not be ranked again before claiming: ${message(cause)}`, "ticket-set", {
			cause,
		});
	}

	if (now.pick !== null && ticketId(now.pick.ref) === ticketId(ref)) return;
	const instead = now.pick === null ? "nothing is startable now" : `${formatTicketRef(now.pick.ref)} is now`;
	throw new ClaimError(
		`${formatTicketRef(ref)} is no longer the ticket to start; ${instead}`,
		"unavailable",
	);
}

function startWork(
	options: Options,
	selection: Selection,
	pick: Candidate,
	tickets: readonly MarkdownTicket[],
	deps: CliDeps,
	effortRoot: string,
	filter: LabelFilter,
): CliResult {
	const id = ticketId(pick.ref);
	const ticket = tickets.find((candidate) => ticketId(candidate.ref) === id);
	if (ticket === undefined) {
		// The pick comes from these same tickets, so this is a corrupted invariant rather than an input
		// the user can fix — reported as a refusal instead of a claim written against a guessed file.
		return { code: 2, stdout: "", stderr: `${formatTicketRef(pick.ref)} is not in the effort it was picked from\n` };
	}

	// Built by branching rather than by a condition over both fields, so the corner with nobody to ask
	// has to return rather than fall through.
	let confirm: (plan: LaunchPlan) => boolean;
	if (options.yes) {
		confirm = () => true;
	} else if (deps.confirm === null) {
		return { code: 2, stdout: "", stderr: "there is no terminal to confirm on; pass --yes to claim without asking\n" };
	} else {
		const ask = deps.confirm;
		confirm = (plan) => {
			try {
				return ask(gate(selection, plan));
			} catch (cause) {
				throw new ConfirmError(`the gate could not be put: ${message(cause)}`);
			}
		};
	}

	let outcome;
	try {
		outcome = prepareLaunch({
			ref: pick.ref,
			slashCommand: DEFAULT_SLASH_COMMAND,
			claimer: markdownClaimer(ticket, { runner: deps.runner }),
			confirm,
			recheck: () => stillStartable(effortRoot, pick.ref, filter, deps),
		});
	} catch (cause) {
		// Neither of these claimed anything: both come before the claim.
		if (cause instanceof CommandBuilderError || cause instanceof ConfirmError) {
			return { code: 2, stdout: "", stderr: `${message(cause)}\n` };
		}
		if (cause instanceof ClaimError) {
			return { code: CLAIM_FAILURE_STATUS[cause.kind], stdout: "", stderr: `${message(cause)}\n` };
		}
		if (cause instanceof LaunchError) return { code: 3, stdout: "", stderr: `${message(cause)}\n` };
		throw cause;
	}

	if (options.json) return { code: outcome.kind === "launched" ? 0 : 1, stdout: json(selection, outcome), stderr: "" };

	if (outcome.kind === "declined") {
		// The gate printed the pick on its way to asking, so repeating it here would show it twice.
		return { code: 1, stdout: `${formatTicketRef(pick.ref)} not claimed\n`, stderr: "" };
	}

	const launch = outcome.launch;
	const claimed = `claimed ${formatTicketRef(launch.hold.ref)}\n`;
	// --yes was never shown the gate's rendering, so it gets the whole answer here.
	if (!options.yes) return { code: 0, stdout: claimed, stderr: "" };
	return {
		code: 0,
		stdout: `${renderSelection(selection)}${claimed}would run: ${formatCommand(launch.command)}\n`,
		stderr: "",
	};
}

/**
 * What each way of failing to claim exits with. A map rather than a test against one arm, so a kind
 * added later fails to compile here instead of quietly becoming the answer that says come back later.
 */
export const CLAIM_FAILURE_STATUS: Record<ClaimError["kind"], 2 | 3> = {
	unavailable: 3,
	"ticket-set": 2,
	// The claim is on the ticket and no later run will reach it, so this needs a person, like a ticket
	// set that will not read.
	stranded: 2,
};

/** What the gate shows before it asks: the pick, why it won, and exactly what approving it runs. */
function gate(selection: Selection, plan: LaunchPlan): string {
	return `${renderSelection(selection)}would run: ${formatCommand(plan.command)}\nclaim it and start work? [y/N]`;
}

/**
 * The selection document, plus what this invocation did about it. Both fields are read off the outcome
 * rather than passed alongside it, so no branch can report a claim on a path that took none, or drop a
 * command that was worked out and shown. Both keys are always present, so a consumer can read either
 * without first testing whether it is there.
 */
function json(selection: Selection, outcome: LaunchOutcome | null): string {
	const command = outcome === null ? null : outcome.kind === "launched" ? outcome.launch.command : outcome.plan.command;
	const claimed = outcome?.kind === "launched";
	return `${JSON.stringify({ ...selectionJson(selection), claimed, command }, null, "\t")}\n`;
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
