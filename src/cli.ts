import { type Argv, DEFAULT_SLASH_COMMAND, WORKSPACE_HOST, formatCommand, isSlashCommand } from "./command-builders";
import type { BlockedState } from "./effective-blockedness";
import { GitHubAdapterError, isReadableLimit, readGitHubTicket, readGitHubTicketSet } from "./github-adapter";
import { GitHubClaimError, claimGitHubTicket } from "./github-claim";
import {
	DEFAULT_LABEL_FILTER,
	type LabelFilter,
	LabelFilterError,
	type LabelFilterSpec,
	compileLabelFilter,
} from "./label-filter";
import { LaunchError, launch, planLaunch, requireSessionBinary, requireWorkspaceHost } from "./launcher";
import { decideOverride } from "./override";
import { type OverrideAnswer, forcedCaveats, overrideJson, renderOverride, renderRefusal } from "./override-output";
import type { Runner } from "./runner";
import {
	type Answer,
	answerCaveats,
	answerJson,
	blockingPhrase,
	readCaveats,
	readDegradedJson,
	renderAnswer,
} from "./selection-output";
import { SelectionError, select } from "./selector";
import type { Ticket } from "./ticket";
import { type TicketRef, TicketRefError, formatTicketRef, resolveTicketRef } from "./ticket-ref";
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
	 * The checkout the command was invoked in, which the worktree step resolves the primary one from.
	 *
	 * Must be where the process itself is standing. The read resolves its repository from the process's own
	 * directory, per ADR-0029 — so a `cwd` naming anywhere else would claim a ticket in one repository and build
	 * the worktree in another.
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
shows you the pick. Once you agree, it makes the ticket's worktree, claims the ticket, and asks the workspace
host to run a session in that worktree. Name a ticket instead and it starts that one.

usage: nextup [--include <label>]... [--exclude <label>]... [--limit <n>] [--slash-command </verb>]
              [--yes] [--json] [--print-command]
       nextup <ticket> [--force] [--slash-command </verb>] [--yes] [--json] [--print-command]

  <ticket>                 start this ticket rather than the ranking's pick: a short form like gh:12 or
                           gh:<owner>/<name>#12, or an issue URL pasted from a browser
  --force                  start the named ticket past the blocked and claimed checks, loudly
  --include <label>        consider only tickets carrying one of these labels; repeatable
  --exclude <label>        never consider a ticket carrying one of these labels; repeatable
  --limit <n>              how many open tickets to consider; ${DEFAULT_LIMIT} by default
  --slash-command </verb>  what the started session runs; ${DEFAULT_SLASH_COMMAND} by default, so the same
                           command can start an implementation, a triage, or a research session
  --yes                    start the pick without asking first
  --print-command          print the session command, and start, claim and create nothing
  --json                   emit the answer as JSON rather than the human rendering
  --help, -h               print this

Naming a ticket skips the ranking and the label filter, which both decide only what may be recommended.
The checks about whether work can start on it stay: a closed, claimed or confirmed-blocked ticket is
refused, with every failed check named. --force starts past a claimed or blocked one, says so on a
"forced: " line, and claims it anyway, so the work stays visible to everyone else. It does not reach a
closed ticket — reopen that instead. A ticket whose blocking state the tracker could not report is not
blocked and needs no flag; the pick's own line says which of the three it is.

The flags that describe a ticket set — --include, --exclude, --limit — are refused beside a named ticket
rather than ignored, since no set is read. --force without one is refused for the same reason. With a
named ticket, --print-command reads no tracker at all: it writes nothing, so there is nothing to check,
and it stays usable with no credentials.

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

A workspace host that does not answer is a failure, not a fallback: the run stops, before the worktree and
the claim. The session binary is checked there too, since a host accepts a command without reporting whether
it ran — so the last thing a run can prove is that the host took the request, and that is all it claims.

Only open tickets are read, so the limit is spent on tickets a pick can come from. The window is the most
recently created of them, so a repository with more open tickets than the limit never considers its oldest
ones, and a read that hits the limit says so on a "degraded: " line. Raising --limit past your open count is
what widens that window; --include cannot, because it narrows what may be recommended from within whatever
was read. A tracker that could not be reached reports that same line beside its own, and there the answer is
to retry rather than to change anything.

Exit status: 0 the command did what was asked — a session requested, a command printed, or a pick you were
shown and declined; 1 nothing to recommend; 2 something needing a person — a repository that cannot be
resolved, a read that is itself wrong, a bad invocation, no way to confirm and no --yes, a workspace host that
is not running, a worktree that cannot be made, a claim that would not land, or a session that could not be
started. A tracker that could not be reached is reported as a degraded answer with nothing to recommend,
which is 1.

A named ticket is never 1: there was no recommendation to be absent. One that a check refused is 2, and so is
one that could not be read — including a tracker that could not be reached, because the one ticket was the
whole answer and there is no degraded version of it to hand back.

Declining is 0 rather than a status of its own. A script that needs to know what happened passes --yes, which
never declines, and reads the "start" object under --json — whose "requested" is the furthest this reports,
because nothing it can see says the session itself came up.

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

	let named: TicketRef | null;
	try {
		// Resolved here rather than in `parse`, which is handed no runner: a bare `gh:12` is resolved against the
		// working directory's remote, and a pasted URL against the tracker CLIs' authenticated hosts.
		named = options.named === null ? null : resolveTicketRef(options.named, { runner: deps.runner });
	} catch (cause) {
		return usageError(cause);
	}
	if (named !== null) return runNamed(named, options, deps);

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
 * A run on the ticket the operator named: read that ticket, apply the checks, and start it. The ranking is not
 * consulted and neither is the label filter, because both decide what may be *recommended* — ADR-0037.
 *
 * The refusal is exit 2 rather than the 1 that means nothing to recommend: a named ticket that cannot be started
 * is a thing for a person to act on, and there was never a recommendation to be absent. A read that failed is
 * the same status for the same reason — the one ticket was the whole answer, so there is no degraded one to give.
 */
function runNamed(ref: TicketRef, options: Options, deps: CliDeps): CliResult {
	if (options.printCommand) {
		// Starts nothing, creates nothing and claims nothing, and the command follows from the reference alone, so
		// this reads no tracker and cannot refuse — ADR-0037, which is also why that costs nothing worth having.
		try {
			return namedResult({ kind: "printed", command: planLaunch({ ref, slashCommand: options.slashCommand }).command }, null, options);
		} catch (cause) {
			return failedStart(cause);
		}
	}

	let answer: OverrideAnswer;
	try {
		const read = readGitHubTicket({ runner: deps.runner, ref });
		answer = { override: decideOverride({ read, force: options.force }), readDegraded: read.degraded };
	} catch (cause) {
		return failedAnswer(cause);
	}

	const override = answer.override;
	if (override.kind === "refused") {
		return { code: 2, stdout: "", stderr: renderRefusal(override.refusals, override.target) };
	}

	let start: StartOutcome;
	try {
		start = startPick(
			{
				ticket: override.target.ticket,
				blocked: override.target.blocked,
				caveats: [...forcedCaveats(override), ...readCaveats(answer.readDegraded)],
			},
			options,
			deps,
		);
	} catch (cause) {
		return failedStart(cause);
	}
	return namedResult(start, answer, options);
}

/**
 * What a named run wrote, and what it did about the ticket — `null` where `--print-command` answered before
 * anything was read, so the override block is absent rather than reported empty.
 *
 * `readDegraded` sits at the same key the ranked answer puts it at, so one consumer reads both paths.
 */
function namedResult(start: StartOutcome, answer: OverrideAnswer | null, options: Options): CliResult {
	const json = {
		override: answer === null ? null : overrideJson(answer.override),
		readDegraded: answer === null ? [] : readDegradedJson(answer.readDegraded),
		start: startJson(start),
	};
	return {
		code: 0,
		stdout: options.json
			? `${JSON.stringify(json, null, "\t")}\n`
			: `${answer === null ? "" : renderOverride(answer)}${renderStart(start)}`,
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
			/**
			 * The host was asked to run the session, and accepted. Not `started`: nothing this tool can see says the
			 * session came up, and ADR-0036 has why it does not go looking.
			 */
			readonly kind: "requested";
			readonly ref: TicketRef;
			readonly worktree: WorktreeOutcome;
			readonly command: Argv;
	  };

/**
 * Starting work on the pick: the three refusals, then the gate, then the worktree, the claim and the session.
 *
 * Every refusal comes before any of the three writes, so a run that stops at one leaves the repository and the
 * tracker as they were. ADR-0016 orders the first two writes and requires that nothing here unwinds them;
 * ADR-0035 puts the session after both, and is why the host is asked before a person is.
 *
 * The refusals are ordered cheapest-and-most-certain first: having nobody to ask is decidable from the
 * invocation, so it is settled before the host is contacted. `cli.test.ts` asserts that order.
 *
 * @throws StartError where there is nobody to confirm with, and where the claim or the session failed —
 * carrying the worktree, and saying which recovery the failure actually leaves open.
 * @throws WorktreeError from the worktree step, and LaunchError from the host check. Not from the session
 * itself: `startedNothing` has why that one arrives as a `StartError` instead.
 * @throws CommandBuilderError unwrapped, from either of its two raise sites: `--slash-command` naming
 * something `sessionCommand` will not build, which parsing already refused and this backstops, before anything
 * is written; and a claim whose key is not a canonical issue number, which is after the worktree exists.
 * `startedNothing` has why it stays unwrapped there rather than gaining the worktree path.
 */
function startWork(answer: Answer, options: Options, deps: CliDeps): StartOutcome {
	const pick = answer.selection.pick;
	if (pick === null) return { kind: "nothing-to-start" };
	return startPick({ ticket: pick, blocked: pick.blocked, caveats: answerCaveats(answer) }, options, deps);
}

/**
 * The ticket a run is about to start, reduced to what starting it needs — whichever path chose it. The ranking
 * path's pick and the override path's target have nothing else in common: one carries a runner-up and a rung,
 * the other the checks a `--force` cleared, and neither belongs in the write sequence below.
 */
interface StartPick {
	readonly ticket: Pick<Ticket, "ref" | "title" | "labels">;
	/** The whole tri-state, which a `Candidate` cannot carry: a forced start's target can be confirmed blocked. */
	readonly blocked: BlockedState;
	/** The lines the gate has to carry, because nothing has printed them when it is asked. */
	readonly caveats: readonly string[];
}

/** The refusals, the gate, and then the three writes. `startWork`'s own comment is the contract for all of it. */
function startPick(pick: StartPick, options: Options, deps: CliDeps): StartOutcome {
	const ref = pick.ticket.ref;
	// Built first, so the one input that can fail without touching anything fails while that is still true.
	const { command } = planLaunch({ ref, slashCommand: options.slashCommand });
	if (options.printCommand) return { kind: "printed", command };

	requireSomeoneToAsk(options, deps);
	requireWorkspaceHost(deps.runner);
	requireSessionBinary(deps.runner);
	if (!approved(pick, options, deps)) return { kind: "declined", ref };

	const worktree = ensure({ runner: deps.runner, repo: deps.cwd, ticket: pick.ticket });
	try {
		claimGitHubTicket({ runner: deps.runner, ref });
		launch({ runner: deps.runner, ref, command, worktree: worktree.path });
		return { kind: "requested", ref, worktree, command };
	} catch (cause) {
		throw startedNothing(cause, worktree, command);
	}
}

/**
 * Refuses a run that will need an answer and has nowhere to get one.
 *
 * Separate from `approved`, and called before the workspace host, for the reason `startWork` gives: this is
 * decidable from the invocation, so it must not wait behind a question about the world.
 *
 * @throws StartError where there is nobody to ask. Refused rather than assumed in either direction: assuming
 * yes claims a ticket and starts a session nobody saw, and assuming no makes an unattended run a silent no-op
 * that still reports success.
 */
function requireSomeoneToAsk(options: Options, deps: CliDeps): void {
	if (options.yes || deps.confirm !== null) return;
	throw new StartError(
		"there is no terminal to confirm on, so nothing was started — pass --yes to answer in advance, or --print-command to get the command without starting anything",
	);
}

/**
 * Whether to go ahead. `--yes` answers in advance; otherwise the person at the terminal is asked.
 *
 * The question restates the pick, for the reason `Confirm` gives, and carries `StartPick.caveats`, because none
 * of them have been printed when it is asked. `blockingPhrase` is why the blocking state is one of them; the
 * rest follow the same reasoning, since a pick from a truncated read is one a better candidate may beat — and a
 * named ticket started past an open blocker is one the operator has to be asked about while that is still
 * news. Every wording comes from the rendering rather than being restated here.
 *
 * A deadlock is deliberately not among them, though it is reported beside the answer: it names tickets that
 * block each other, which is a fact about that cycle rather than about whether this pick can be started, and
 * `USAGE` says why it never decides the exit status either.
 */
function approved(pick: StartPick, options: Options, deps: CliDeps): boolean {
	if (options.yes) return true;
	if (deps.confirm === null) {
		// `requireSomeoneToAsk` already refused this, so reaching it means the two disagree about the same inputs.
		throw new StartError("there is no terminal to confirm on, so nothing was started");
	}
	const lines = [
		`start ${formatTicketRef(pick.ticket.ref)} — ${pick.ticket.title}`,
		`  ${blockingPhrase(pick)}`,
		...pick.caveats.map((caveat) => `  ${caveat}`),
		"claim it and start a session in its own worktree? [y/N]",
	];
	return deps.confirm(lines.join("\n"));
}

/** Why the run started nothing, where that is a thing for a person rather than a mistake on the command line. */
class StartError extends Error {}

/**
 * A failure after the worktree was made, told with the worktree beside it and with the recovery that failure
 * leaves open. The two arms are separate because those recoveries differ: a failed claim leaves the ticket
 * claimable and so re-running works, while a failed session does not and must not say it does. ADR-0035's
 * Consequences have why, and why releasing the claim is not the alternative.
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
			// The `cd` goes through `formatCommand` too: this line is the only recovery offered for an already-claimed
			// ticket, so it has to survive a checkout path holding a space, which is ordinary rather than exotic.
			`${cause.message}\nThe ticket is claimed and ${worktree.path} is in place on ${worktree.branch}. Running this again would pick a different ticket, because a claimed one is no longer a candidate — so start this session yourself instead:\n  ${formatCommand(["cd", worktree.path])} && ${formatCommand(command)}`,
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
		case "requested":
			// "asked", not "started": see `StartOutcome`'s own arm.
			return `${renderWorktree(start.worktree)}claimed ${formatTicketRef(start.ref)}\nasked ${WORKSPACE_HOST} to run ${formatCommand(start.command)}\n`;
	}
}

/** `StartOutcome` with every reference in the short form `CandidateJson` uses. */
export type StartOutcomeJson =
	| Extract<StartOutcome, { readonly kind: "nothing-to-start" | "printed" }>
	| ShortRef<"declined">
	| ShortRef<"requested">;

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
		case "requested":
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
	readonly force: boolean;
	readonly limit: number;
	readonly slashCommand: string;
	readonly filter: LabelFilterSpec;
	/**
	 * The ticket named on the command line, as written — unresolved, because resolving one reads a git remote or
	 * a CLI's authenticated hosts and `parse` is handed nothing to read with.
	 */
	readonly named: string | null;
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
	let force = false;
	let limit = DEFAULT_LIMIT;
	let slashCommand = DEFAULT_SLASH_COMMAND;
	let named: string | null = null;
	const include: string[] = [];
	const exclude: string[] = [];
	const given = new Set<string>();

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		given.add(flag);
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
			case "--force":
				force = true;
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
				if (flag.startsWith("-")) throw new CliError(`${flag} is not a flag this command takes`);
				if (named !== null) throw new CliError(`${named} and ${flag} are two tickets, and a run starts one`);
				named = flag;
		}
	}
	requireFlagsThatApply(named, given);

	// Prepended rather than replaced, so the defaults are a floor a filter flag cannot lift; ADR-0031 has why.
	return {
		json,
		yes,
		printCommand,
		force,
		limit,
		slashCommand,
		named,
		filter: { include, exclude: [...DEFAULT_LABEL_FILTER.exclude, ...exclude] },
	};
}

/** The flags each path has no use for, which every one of the three describes a ticket set or the override. */
const ABOUT_THE_SET: readonly string[] = ["--limit", "--include", "--exclude"];

/**
 * Refuses a line whose flags and ticket disagree about which path is being run.
 *
 * Refused rather than ignored, because each of these flags describes work the run will not do: a set read that
 * never happens, or checks there is no named ticket to clear. Accepting one silently is how an operator comes to
 * believe a filter narrowed something — the failure `renderFilter` exists to prevent on the other path.
 */
function requireFlagsThatApply(named: string | null, given: ReadonlySet<string>): void {
	if (named === null) {
		if (given.has("--force")) {
			throw new CliError("--force starts a named ticket past the blocked and claimed checks, and this run names none");
		}
		return;
	}
	const aboutTheSet = ABOUT_THE_SET.filter((flag) => given.has(flag));
	if (aboutTheSet.length > 0) {
		throw new CliError(
			`${aboutTheSet.join(" and ")} describe the ticket set a run ranks, and naming ${named} reads no set at all`,
		);
	}
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
	// A reference that will not resolve is among them: what the command line said cannot be used, which is the
	// same thing a bad flag is, and the usage beside it is where the accepted forms are written down.
	if (cause instanceof CliError || cause instanceof LabelFilterError || cause instanceof TicketRefError) {
		return { code: 2, stdout: "", stderr: `${cause.message}\n\n${USAGE}` };
	}
	throw cause;
}
