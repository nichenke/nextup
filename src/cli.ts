import {
	type Argv,
	DEFAULT_SLASH_COMMAND,
	WORKSPACE_HOST,
	formatCommand,
	isSlashCommand,
} from "./command-builders";
import type { BlockedState } from "./effective-blockedness";
import { GitHubAdapterError, isReadableLimit, readGitHubTicket, readGitHubTicketSet } from "./github-adapter";
import { GitHubClaimError, claimGitHubTicket, outsideThisCheckout } from "./github-claim";
import {
	DEFAULT_LABEL_FILTER,
	type LabelFilter,
	LabelFilterError,
	type LabelFilterSpec,
	compileLabelFilter,
} from "./label-filter";
import { type CheckoutIdentity, type RefuseCheckout, resolveCheckoutIdentity } from "./checkout-identity";
import { LaunchError, launch, planLaunch, requireSessionBinary, requireWorkspaceHost } from "./launcher";
import { decideOverride } from "./override";
import { type OverrideAnswer, forcedCaveats, overrideJson, renderForced, renderOverride, renderRefusal } from "./override-output";
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
import type { Claim, Ticket } from "./ticket";
import { type GitHubTicketRef, type TicketRef, TicketRefError, formatTicketRef, githubTicketTarget, resolveTicketRef } from "./ticket-ref";
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
	 * The checkout the command was invoked in: both the repository the run's tickets are read from and the one the
	 * worktree step resolves the primary checkout from.
	 *
	 * One value for both. The origin read is given this directory too —
	 * ADR-0042 — so a `cwd` naming somewhere else moves the whole run there instead of claiming a ticket in one
	 * repository and building the worktree in another.
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

A named ticket has to live in the repository you are standing in, and one from anywhere else is refused:
the claim would land there while the worktree and the session were made here.

The flags that describe a ticket set — --include, --exclude, --limit — are refused beside a named ticket
rather than ignored, since no set is read. --force is refused without a named ticket, and also beside
--print-command, which runs no check for it to clear.

With a named ticket, --print-command reads no ticket, so it cannot tell you that one is blocked. It does
still resolve the reference — which reads this checkout's git remote, and for a pasted URL decides GitHub by
the host alone and asks the glab CLI about anything else.

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

/**
 * The repository this run is standing in, asked for on demand and resolved at most once.
 *
 * A function rather than a value, because not every run needs one: `--help` and a usage error answer without
 * touching git, and a `gh:<owner>/<name>#12` typed in a directory with no remote is still a reference this can
 * refuse on its own terms. A memo rather than a second resolution, so that the claim and the check that came
 * before it cannot disagree about where "here" is — ADR-0040.
 *
 * `refuse` belongs to the caller because the class decides the recovery: a failed identification is a
 * `StartError` where a start was being attempted and a usage error where a reference was being parsed.
 */
type Checkout = (refuse: RefuseCheckout) => CheckoutIdentity;

function checkoutResolver(deps: CliDeps): Checkout {
	let resolved: CheckoutIdentity | null = null;
	// Only the success is remembered. Caching the failure was tried and removed: it would hand a later caller the
	// first one's error class, which is the collapse the `refuse` callback exists to prevent, and it can buy
	// nothing because every caller here ends the run on the first throw.
	return (refuse) => (resolved ??= resolveCheckoutIdentity(deps.runner, deps.cwd, refuse));
}

export function run(argv: readonly string[], deps: CliDeps): CliResult {
	if (asksForHelp(argv)) return { code: 0, stdout: USAGE, stderr: "" };

	let options: Options;
	try {
		options = parse(argv);
	} catch (cause) {
		return usageError(cause);
	}

	const checkout = checkoutResolver(deps);

	let named: TicketRef | null;
	try {
		// Resolved here rather than in `parse`, which is handed no runner: a bare `gh:12` is resolved against this
		// checkout's remote, and a pasted URL against the tracker CLIs' authenticated hosts.
		named = options.named === null ? null : resolveTicketRef(options.named, { runner: deps.runner, directory: deps.cwd, checkout });
	} catch (cause) {
		return usageError(cause);
	}
	if (named !== null) return runNamed(named, options, deps, checkout);

	let filter: LabelFilter;
	try {
		filter = compileLabelFilter(options.filter);
	} catch (cause) {
		return usageError(cause);
	}

	// Resolved before the read rather than left to the adapter's own fallback, so that the set this ranks and the
	// claim it ends with are provably about one repository: both take this value. ADR-0040.
	let here: CheckoutIdentity;
	try {
		here = checkout((reason) => new StartError(`a run ranks the tickets of the repository it is standing in, and ${reason}`));
	} catch (cause) {
		return failedStart(cause);
	}

	let answer: Answer;
	try {
		const read = readGitHubTicketSet({ runner: deps.runner, limit: options.limit, repo: here.repo });
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
		start = startWork(answer, options, deps, checkout);
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
 * Neither a refusal nor a failed read is ever the 1 that means nothing to recommend, for the reason `USAGE` gives.
 */
function runNamed(ref: TicketRef, options: Options, deps: CliDeps, checkout: Checkout): CliResult {
	// Before the print branch too, because what that prints is a line to paste and run in this checkout.
	try {
		requireTicketInThisCheckout(ref, checkout);
	} catch (cause) {
		return failedStart(cause);
	}

	if (options.printCommand) {
		// Starts nothing, creates nothing and claims nothing, so it reads no tracker — ADR-0037. The tracker is
		// still checked, because "reads nothing" is not "accepts anything": without this, a `jira:` reference
		// prints a command every other path refuses, and the refusal is pure and reads nothing either. A padded
		// key needs no check here, having been refused where the reference was built.
		const target = githubTicketTarget(ref);
		if (target.kind === "refused") return usageError(new CliError(target.reason));
		return namedResult({ kind: "printed", command: planLaunch({ ref, slashCommand: options.slashCommand }).command }, null, options);
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
		// Under --json this is an answer rather than a failure: the checks ran and said no, so a consumer gets the
		// same document a started run gets, and the exit status is what tells the two apart. The human form keeps
		// the prose on stderr, where every other refusal this command makes is written.
		return options.json
			? { ...namedResult(null, answer, options), code: 2 }
			: { code: 2, stdout: "", stderr: renderRefusal(answer) };
	}

	let start: StartedSomething;
	try {
		start = startPick(
			{
				ticket: override.target.ticket,
				blocked: override.target.blocked,
				caveats: [...forcedCaveats(override), ...readCaveats(answer.readDegraded, "kept")],
				claim: override.target.ticket.claim,
				named: true,
			},
			options,
			deps,
			checkout,
		);
	} catch (cause) {
		return failedStart(cause);
	}
	return namedResult(start, answer, options);
}

/**
 * What a named run decided and what it wrote, as one result. Either half may be missing, and each says so as an
 * explicit `null` rather than a dropped key, the way `selectionJson` does and for the same reason: `answer` is
 * null where `--print-command` answered before anything was read, and `start` is null where a refusal stopped the
 * run before the writes.
 *
 * There is no `selection` key, because nothing was ranked — `README.md` says what that means for a consumer
 * handling both paths. `readDegraded` is the one field an absence does not distinguish: it is `[]` both for a read
 * that degraded in no way and for the `--print-command` branch that never read, which `override: null` is what
 * tells apart.
 *
 * `start` cannot be `nothing-to-start`: that arm means the ladder had nothing to recommend, and a named ticket is
 * what there was to start. Excluding it is what makes `USAGE`'s "a named ticket is never 1" a type fact.
 *
 * `readDegraded` sits at the same key the ranked answer puts it at, so one consumer reads both paths.
 */
function namedResult(start: StartedSomething | null, answer: OverrideAnswer | null, options: Options): CliResult {
	const json = {
		override: answer === null ? null : overrideJson(answer.override),
		readDegraded: answer === null ? [] : readDegradedJson(answer.readDegraded),
		start: start === null ? null : startJson(start),
	};
	return {
		code: 0,
		stdout: options.json
			? `${JSON.stringify(json, null, "\t")}\n`
			: `${answer === null ? "" : renderOverride(answer)}${forced(start, answer)}${start === null ? "" : renderStart(start)}`,
		stderr: "",
	};
}

/** A `StartOutcome` from a run that had something to start, which every named run has by construction. */
type StartedSomething = Exclude<StartOutcome, { readonly kind: "nothing-to-start" }>;

/**
 * What a `--force` cleared, reported only by a run that went through with it — `renderForced` has why a declined
 * run must not claim to have forced anything, and the gate is where that run was told instead.
 */
function forced(start: StartedSomething | null, answer: OverrideAnswer | null): string {
	if (answer === null || start === null || start.kind !== "requested") return "";
	return renderForced(answer.override);
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
 * @throws CommandBuilderError unwrapped, from `--slash-command` naming something `sessionCommand` will not
 * build — which parsing already refused and this backstops, before anything is written. The claim's own
 * canonical-key assertion raises `TicketRefError` and is unreachable: `githubTicketRef` refuses a padded key at
 * construction, so no reference reaching here can carry one (ADR-0039).
 */
function startWork(answer: Answer, options: Options, deps: CliDeps, checkout: Checkout): StartOutcome {
	const pick = answer.selection.pick;
	if (pick === null) return { kind: "nothing-to-start" };
	// `claim: null` is a fact rather than a default: `place` puts a claimed ticket outside the candidate set, so a
	// pick that reached here carried no claim when it was read.
	return startPick({ ticket: pick, blocked: pick.blocked, caveats: answerCaveats(answer), claim: null, named: false }, options, deps, checkout);
}

/**
 * The ticket a run is about to start, reduced to what starting it needs — whichever path chose it. The two paths
 * agree on nothing else: one arrives beside a `Decision` naming the rung and the runner-up, the other beside the
 * `Override.forced` a `--force` cleared, and neither belongs in the write sequence below.
 */
interface StartPick {
	readonly ticket: Pick<Ticket, "ref" | "title" | "labels">;
	/** The whole tri-state, which a `Candidate` cannot carry: a forced start's target can be confirmed blocked. */
	readonly blocked: BlockedState;
	/** The lines the gate has to carry, because nothing has printed them when it is asked. */
	readonly caveats: readonly string[];
	/**
	 * The claim the ticket already carried, so a failed claim can say what is on the ticket instead of asserting it
	 * is unclaimed. Always null on the ranking path, where a claimed ticket is not a candidate at all; a forced
	 * start is the one way this is set.
	 */
	readonly claim: Claim | null;
	/**
	 * Whether the operator named this ticket. It decides what a failed *session* leaves open, which is the one
	 * recovery the two paths do not share: a named ticket is named again by a re-run, where a ranked one is no
	 * longer a candidate once claimed and a re-run would pick something else.
	 */
	readonly named: boolean;
}

/** The refusals, the gate, and then the three writes. `startWork`'s own comment is the contract for all of it. */
function startPick(pick: StartPick, options: Options, deps: CliDeps, checkout: Checkout): StartedSomething {
	const ref = pick.ticket.ref;
	// Built first, so the one input that can fail without touching anything fails while that is still true.
	const { command } = planLaunch({ ref, slashCommand: options.slashCommand });
	if (options.printCommand) return { kind: "printed", command };

	// Narrowed here rather than at the claim, so that a tracker with no adapter is refused before the worktree
	// exists rather than after it. Neither path can currently deliver one — the ranked pick comes from the GitHub
	// adapter and the named one from a read that refuses anything else — so this states the requirement the write
	// sequence has rather than catching a live case.
	const target = githubTicketTarget(ref);
	if (target.kind === "refused") throw new StartError(target.reason);

	requireSomeoneToAsk(options, deps);
	// Before the host pings and before the question, not merely before the writes: this reads one local git
	// command and settles whether the run can happen at all, so asking a person to confirm a start it is about to
	// refuse would be asking about nothing. A ranked ticket is compared nowhere else —
	// `requireTicketInThisCheckout` only ever sees a named one.
	const here = checkout((reason) => new StartError(`${formatTicketRef(ref)} cannot be claimed, because ${reason}`));
	requireInThisCheckout(target.ref, here);

	requireWorkspaceHost(deps.runner);
	requireSessionBinary(deps.runner);
	if (!approved(pick, options, deps)) return { kind: "declined", ref };

	const worktree = ensure({ runner: deps.runner, repo: deps.cwd, ticket: pick.ticket });
	try {
		claimGitHubTicket({ runner: deps.runner, ref: target.ref, checkout: here });
		launch({ runner: deps.runner, ticket: pick.ticket, command, worktree: worktree.path });
		return { kind: "requested", ref, worktree, command };
	} catch (cause) {
		throw startedNothing(cause, pick, worktree, command);
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
 * Anything unclassified is returned untouched, keeping its stack: `ensure` is idempotent, so the worktree is
 * recoverable without a message naming it, and a stack says more about a broken invariant than a sentence about
 * recovery would.
 */
function startedNothing(cause: unknown, pick: StartPick, worktree: WorktreeOutcome, command: Argv): unknown {
	if (cause instanceof GitHubClaimError) {
		// What the tracker holds, not what a ranked pick would have held: a forced start overruled a claim that is
		// still there, and telling the operator the ticket is unclaimed would be plainly false.
		//
		// That it is claimed, and no count of by how many: `readClaim` keeps the first assignee and says that which
		// one it reports is display, so a `Claim` cannot establish that there was only one. The claimant is named as
		// one of them rather than as the holder, which is what that field can support.
		//
		// The unnamed-claimant arm has no test and cannot get one here: `readClaim` demands a login from GitHub's
		// assignees, so this tracker cannot produce a `Claim` without one. It is written for an adapter that can,
		// which is the case `Claim.by` exists for.
		const standing =
			pick.claim === null
				? "the ticket is still unclaimed"
				: `the ticket is still claimed${pick.claim.by === null ? "" : `, with ${pick.claim.by} among its assignees`}`;
		return new StartError(
			`${cause.message}\n${worktree.path} is in place on ${worktree.branch} and ${standing}, so running this again continues from there.`,
		);
	}
	if (cause instanceof LaunchError) {
		// Nothing is predicted about a re-run of a named ticket: what one does there turns on whether the line carried
		// `--force`, which clears the very claim check a warning would be about. The command below is the recovery
		// either way, which is what ADR-0035 leaves this line for.
		//
		// The ranked arm keeps its warning because it turns on nothing a later line can change: a claimed ticket is
		// not a candidate, so a re-run picks something else whatever flags it carries, and an operator who does not
		// know that starts work on the wrong ticket.
		const rerun = pick.named ? "" : "Running this again would pick a different ticket, because a claimed one is no longer a candidate. ";
		return new StartError(
			// The `cd` goes through `formatCommand` too: this line is the only recovery offered for an already-claimed
			// ticket, so it has to survive a checkout path holding a space, which is ordinary rather than exotic.
			`${cause.message}\nThe ticket is claimed and ${worktree.path} is in place on ${worktree.branch}. ${rerun}Start this session yourself instead:\n  ${formatCommand(["cd", worktree.path])} && ${formatCommand(command)}`,
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
 * a `StartError` carrying the worktree. A builder's own assertion is absent deliberately rather than by
 * omission — it is the one failure here whose stack says more than its message, so it takes the unclassified
 * path.
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

/**
 * Refuses a named ticket that lives somewhere other than the checkout the command was invoked in.
 *
 * The two writes would otherwise go to different repositories: `ensure` builds the worktree in `deps.cwd`, and the
 * claim lands wherever the reference names — so naming another repository's ticket claims it there while the
 * worktree and the session are made here, which is the outcome `CliDeps.cwd` exists to prevent. The branch name
 * carries only the key besides, so the worktree could collide with this repository's own ticket of that number.
 *
 * A bare short form can never trip this, because it was resolved from this same checkout; an explicit
 * `repo#number` and a pasted URL can. Checked for `--print-command` too, which prints a line meant to be pasted
 * and run.
 *
 * No host comparison, and nothing should add one back: a `GitHubTicketRef` carries none, and a
 * `CheckoutIdentity` resolves only from a GitHub remote — ADR-0039 and ADR-0040 have the pair.
 *
 * A `StartError` rather than a usage error, though a reference is what triggers it: the remedy is to run the
 * command somewhere else, not to spell the line differently, and the usage beside it would bury that.
 *
 * @throws StartError when the reference names another repository, and when this checkout cannot be identified at
 * all — the second because a reference that may or may not belong here is not one to start work on.
 */
function requireTicketInThisCheckout(ref: TicketRef, checkout: Checkout): void {
	// Only GitHub's, because only GitHub's can be started: a reference on any other tracker is refused a moment
	// later by `githubTicketTarget`, which says why in terms of the tracker rather than of the repository.
	if (ref.tracker !== "github") return;
	requireInThisCheckout(
		ref,
		checkout((reason) => new StartError(`${formatTicketRef(ref)} names a repository, and ${reason}, so nothing was started`)),
	);
}

/**
 * The comparison itself, in the one wording both paths use. `outsideThisCheckout` decides; this decides what a
 * refusal costs the operator, which is a `StartError` either way — the remedy is to correct the remote or to run
 * the command elsewhere, and neither is a thing to respell on the line.
 *
 * @throws StartError when the ticket is in another repository.
 */
function requireInThisCheckout(ref: GitHubTicketRef, here: CheckoutIdentity): void {
	const outside = outsideThisCheckout(ref, here);
	if (outside === null) return;
	throw new StartError(
		`${outside}, so nothing was started. Correct this checkout's origin remote, or run this inside ${ref.repo}.`,
	);
}

/** The flags that describe a ticket set, which a named run reads none of. `--force` is refused separately. */
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
	// Same rule as above, one path along: --print-command runs no check, so there is nothing for --force to clear.
	if (given.has("--force") && given.has("--print-command")) {
		throw new CliError("--print-command runs no check on the named ticket, so --force has nothing to clear");
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
