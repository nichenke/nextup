import { type Argv, CommandBuilderError, DEFAULT_SLASH_COMMAND, formatCommand, isSlashCommand } from "./command-builders";
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
import { type Answer, answerCaveats, answerJson, blockingPhrase, renderAnswer } from "./selection-output";
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
	 * The checkout the command was invoked in, which the worktree step resolves the primary one from. The read
	 * finds its repository through `origin` instead, so this is the one place a filesystem path is needed.
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
session. Nothing unwinds — a step that fails leaves what the steps before it did.

What recovers depends on which step failed, and the abort says which. Up to and including a failed claim,
running the command again continues from what is there. Past it, a claimed ticket is no longer a candidate,
so a re-run would pick a different one — the abort hands you the session command to run in the worktree
instead. Neither case releases the claim, and nothing here rolls back.

The confirmation gate is on by default. It names the pick and its blocking state, since a pick whose
blockers nothing could confirm is worth knowing about before you claim it. --yes answers in advance for an
unattended run. With neither a terminal to ask on nor --yes, the run is refused rather than answered on
your behalf. --print-command never asks, because it starts nothing.

There is no fallback when the workspace host is not running: the run is refused, before the worktree and
the claim. Start the host and run again, or use --print-command and start the session yourself.

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

Declining is 0 rather than a status of its own. A script that needs to know whether a session started passes
--yes, which never declines, and reads the "start" object under --json.

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
		start = startWork(answer, options, deps);
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
	| { readonly kind: "printed"; readonly command: Argv }
	| { readonly kind: "declined"; readonly ref: TicketRef }
	| {
			readonly kind: "started";
			readonly ref: TicketRef;
			readonly worktree: WorktreeOutcome;
			readonly command: Argv;
	  };

/**
 * Starting work on the pick: the workspace host, then the gate, then the worktree, the claim and the session.
 *
 * Both refusals come before any of the three writes, so a run that stops at either leaves the repository and
 * the tracker as they were. ADR-0016 orders the first two writes and requires that nothing here unwinds them;
 * ADR-0035 puts the session after both, and is why the host is asked before the gate rather than after.
 *
 * @throws StartError where there is nobody to confirm with, and where the claim or the session failed —
 * carrying the worktree, and saying which recovery the failure actually leaves open.
 * @throws WorktreeError from the worktree step, and LaunchError from the host check. Not from the session
 * itself: `startedNothing` has why that one arrives as a `StartError` instead.
 * @throws CommandBuilderError unwrapped, before anything is asked or written, where `--slash-command` named
 * something `sessionCommand` will not build. Parsing already refused that, so this is a backstop.
 */
function startWork(answer: Answer, options: Options, deps: CliDeps): StartOutcome {
	const pick = answer.selection.pick;
	if (pick === null) return { kind: "nothing-to-start" };
	// Built first, so the one input that can fail without touching anything fails while that is still true.
	const { command } = planLaunch({ ref: pick.ref, slashCommand: options.slashCommand });
	if (options.printCommand) return { kind: "printed", command };

	requireWorkspaceHost(deps.runner);
	if (!approved(answer, pick, options, deps)) return { kind: "declined", ref: pick.ref };

	const worktree = ensure({ runner: deps.runner, repo: deps.cwd, ticket: pick });
	try {
		claimGitHubTicket({ runner: deps.runner, ref: pick.ref });
		launch({ runner: deps.runner, ref: pick.ref, command, worktree: worktree.path });
		return { kind: "started", ref: pick.ref, worktree, command };
	} catch (cause) {
		throw startedNothing(cause, worktree, command);
	}
}

/**
 * Whether to go ahead. `--yes` answers in advance; otherwise the person at the terminal is asked.
 *
 * The question restates the pick, for the reason `Confirm` gives, and carries every caveat the answer holds,
 * because none of them have been printed when it is asked. `blockingPhrase` is why the blocking state is one
 * of them; the rest follow the same reasoning, since a pick from a truncated read is one a better candidate
 * may beat and the operator would learn that only after claiming it. Both wordings come from the rendering
 * rather than being restated here.
 *
 * @throws StartError where there is nobody to ask. Refused rather than assumed in either direction: assuming
 * yes claims a ticket and starts a session nobody saw, and assuming no makes an unattended run a silent
 * no-op that still reports success.
 */
function approved(answer: Answer, pick: Candidate, options: Options, deps: CliDeps): boolean {
	if (options.yes) return true;
	if (deps.confirm === null) {
		throw new StartError(
			"there is no terminal to confirm on, so nothing was started — pass --yes to answer in advance, or --print-command to get the command without starting anything",
		);
	}
	const lines = [
		`start ${formatTicketRef(pick.ref)} — ${pick.title}`,
		`  ${blockingPhrase(pick)}`,
		...answerCaveats(answer).map((caveat) => `  ${caveat}`),
		"claim it and start a session in its own worktree? [y/N]",
	];
	return deps.confirm(lines.join("\n"));
}

/** Why the run started nothing, where that is a thing for a person rather than a mistake on the command line. */
class StartError extends Error {}

/**
 * A failure after the worktree was made, told with the worktree beside it and with the recovery that failure
 * actually leaves open — which is not the same one for the two steps, and this is the whole reason the two
 * arms are separate.
 *
 * A failed claim leaves the ticket unclaimed, so re-running reaches it again and `ensure` attaches to the
 * worktree already there. That is ADR-0016's recovery path, and it works.
 *
 * A failed session does not. The claim landed, and `place` in `selector.ts` buckets any ticket carrying a
 * claim as claimed and drops it before the ladder — so a re-run cannot pick this ticket, and would claim and
 * start a *different* one while this stayed claimed with nobody working it. Telling an operator to re-run
 * here would be telling them to start the wrong work, so the session command is given instead. Releasing the
 * claim is not the alternative: ADR-0016 forbids a release path, and the release is itself a call that fails.
 *
 * `CommandBuilderError` is deliberately not wrapped, though the claim can raise one for a key that is not a
 * canonical issue number. `github-claim.ts` leaves it unwrapped so a stack naming the builder survives, per
 * ADR-0032, and re-wrapping it to add a worktree path would spend exactly that. Anything else unclassified is
 * returned untouched for the same reason — `ensure` is idempotent, so the worktree is recoverable without it.
 */
function startedNothing(cause: unknown, worktree: WorktreeOutcome, command: Argv): unknown {
	if (cause instanceof GitHubClaimError) {
		return new StartError(
			`${cause.message}\n${worktree.path} is in place on ${worktree.branch} and the ticket is still unclaimed, so running this again continues from there.`,
		);
	}
	if (cause instanceof LaunchError) {
		return new StartError(
			`${cause.message}\nThe ticket is claimed and ${worktree.path} is in place on ${worktree.branch}. Running this again would pick a different ticket, because a claimed one is no longer a candidate — so start this session yourself instead:\n  cd ${worktree.path} && ${formatCommand(command)}`,
		);
	}
	return cause;
}

/**
 * Whatever refused to start the work, as something for a person to fix. Every class here is a refusal this
 * code wrote, so the message is the whole report; anything else keeps its stack, for the reason
 * `failedAnswer` gives.
 *
 * `GitHubClaimError` is absent because it cannot arrive: `startedNothing` turns the claim's own failure into
 * a `StartError` carrying the worktree. `CommandBuilderError` is absent deliberately rather than by omission
 * — it is the one failure here whose stack says more than its message, so it takes the unclassified path.
 */
function failedStart(cause: unknown): CliResult {
	if (cause instanceof StartError || cause instanceof WorktreeError || cause instanceof LaunchError) {
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
	| ShortRef<"declined">
	| ShortRef<"started">;

/**
 * One arm with its reference as the short form, its own other fields carried over so a field added to that arm
 * reaches the output. `ShortRefs` in `selection-output.ts` is the same shape for the same reason.
 */
type ShortRef<K extends StartOutcome["kind"]> = Omit<Extract<StartOutcome, { readonly kind: K }>, "ref"> & {
	readonly ref: string;
};

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
