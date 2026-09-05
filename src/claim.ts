import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { type MarkdownTicketFile, parseTicketText, readTicketFile, withStatus } from "./markdown-adapter";
import type { Claim } from "./ticket";
import { type ResolveDeps, type TicketRef, formatTicketRef } from "./ticket-ref";

/**
 * Why a claim could not be taken, and what the answer costs whoever is listening. `"unavailable"` is
 * the tracker's answer about this ticket right now; `"ticket-set"` says the ticket itself is wrong,
 * which no waiting fixes; `"stranded"` says this run left a claim on a ticket nobody is working, which
 * no waiting fixes *and* which nothing but a person will clear.
 *
 * `stranded` is its own answer rather than an unavailable one because the ticket is not available:
 * `Status: claimed` is on disk, the selector drops claimed tickets, and no later run reaches it. Told
 * to come back later, a caller polling for work waits on a ticket that will never return.
 */
export class ClaimError extends Error {
	readonly kind: "unavailable" | "ticket-set" | "stranded";

	constructor(message: string, kind: ClaimError["kind"], options?: ErrorOptions) {
		super(message, options);
		this.kind = kind;
	}
}

/**
 * A claim that landed. `claimant` is a `Claim` rather than a name, so that markdown's "claimed, by
 * nobody the format can record" cannot be flattened into "nobody has claimed it" on the way into a
 * `Ticket` — `ticket.ts`'s `Claim` says why that read hands the ticket out twice.
 */
export interface ClaimHold {
	readonly ref: TicketRef;
	readonly claimant: Claim;
}

/**
 * What became of a claim asked to give itself back. Three answers rather than a boolean because
 * `nothing-to-release` has no honest boolean: `false` escalates a claim that never existed, and `true`
 * reports a release that never happened.
 *
 * Reported rather than thrown, because a release runs on the way out of an earlier failure and
 * throwing there replaces the reason the caller was already reporting.
 */
export type ReleaseOutcome =
	| { readonly kind: "released" }
	| { readonly kind: "nothing-to-release" }
	| { readonly kind: "stranded"; readonly reason: string };

/**
 * The write half of one tracker, holding a single ticket's claim. Stateful on purpose: a release has
 * to put back exactly what the claim overwrote, and only the object that wrote it knows that.
 *
 * Best-effort by design, per the spec — no compare-and-swap and no expiry. A ticket left claimed with
 * nothing running is visible and correctable by hand, which is cheaper than machinery that would have
 * to be right on four trackers.
 */
export interface Claimer {
	/** @throws ClaimError, and nothing else, so a caller can classify every failure by `kind`. */
	claim(): ClaimHold;
	release(): ReleaseOutcome;
}

export interface MarkdownClaimDeps extends ResolveDeps {
	/**
	 * Re-reads the file the claim was written to. A parameter because the failure it guards — a write
	 * that lands and still reads back unclaimed — is another writer getting there in between, which
	 * nothing stages from outside the process: `withStatus` refuses every edit the reader would not read
	 * back. It stands in for the same event on a real tracker: GitHub accepts an assignment to a user
	 * without repository access and hands the issue back unassigned.
	 */
	readonly readBack?: (path: string) => MarkdownTicketFile;
}

/**
 * Claims a markdown ticket by writing `claimed` into its `Status:` field, which overwrites whatever
 * that line said — `docs/adr/0012-claiming-overwrites-the-markdown-status.md` has why, and what it
 * costs.
 *
 * The file is read once and everything is decided from that text, so a ticket claimed or closed since
 * selection is refused rather than taken from whoever got there first, and no edit is validated in one
 * read and then discarded by a write built from another.
 */
export function markdownClaimer(ticket: MarkdownTicketFile, deps: MarkdownClaimDeps = {}): Claimer {
	const readBack = deps.readBack ?? ((path: string) => readTicketFile(path, deps));
	const path = ticket.path;
	let written: { readonly before: string; readonly after: string } | null = null;

	return {
		claim(): ClaimHold {
			if (written !== null) {
				throw new ClaimError(`${formatTicketRef(ticket.ref)} is already claimed by this run`, "unavailable");
			}

			const before = read(path);
			const current = asTicketSetFailure(path, () => parseTicketText(before, path, deps));
			if (current.state === "closed") {
				throw new ClaimError(
					`${formatTicketRef(ticket.ref)} closed since it was selected; nothing was claimed`,
					"unavailable",
				);
			}
			if (current.claim !== null) {
				throw new ClaimError(
					`${formatTicketRef(ticket.ref)} was claimed since it was selected; nothing was claimed`,
					"unavailable",
				);
			}

			const after = asTicketSetFailure(path, () => withStatus(before, CLAIMED, path));
			replace(path, after);

			// Verified through the reader the selector was fed, so a claim counts as landed only when it
			// is one that reads back as a claim. Anything else rolls the file back, or says it could not,
			// because a half-written claim advertises the ticket as neither taken nor free.
			/**
			 * Reports `cause` after attempting the rollback, naming a claim the rollback could not take
			 * back. Told only that the claim did not verify, a caller would not know one is outstanding.
			 * A stranded claim stays this claimer's to release, so `written` is set: the file still holds
			 * what the claim wrote, and `release` can try again rather than answering that there is
			 * nothing to give back.
			 */
			const rollingBack = (cause: unknown): ClaimError => {
				const failure = cause instanceof ClaimError ? cause : new ClaimError(message(cause), "unavailable", { cause });
				const outcome = revert(path, after, before);
				if (outcome.kind !== "stranded") return failure;
				written = { before, after };
				return new ClaimError(`${failure.message}; the claim was not taken back either: ${outcome.reason}`, "stranded", {
					cause: failure,
				});
			};

			let verified: MarkdownTicketFile;
			try {
				verified = asTicketSetFailure(path, () => readBack(path));
			} catch (cause) {
				throw rollingBack(cause);
			}
			if (verified.claim === null) {
				const refusal = new ClaimError(
					`${formatTicketRef(ticket.ref)} does not read as claimed after being claimed`,
					"unavailable",
				);
				throw rollingBack(refusal);
			}

			written = { before, after };
			return { ref: ticket.ref, claimant: verified.claim };
		},

		release(): ReleaseOutcome {
			const claim = written;
			if (claim === null) return { kind: "nothing-to-release" };
			const outcome = revert(path, claim.after, claim.before);
			if (outcome.kind === "released") written = null;
			return outcome;
		},
	};
}

const CLAIMED = "claimed";

/**
 * Puts `before` back, but only over the exact text the claim wrote. An edit made since is somebody's
 * work, and a ticket left claimed is the visible failure where a discarded edit is the invisible one.
 */
function revert(path: string, after: string, before: string): ReleaseOutcome {
	let current: string;
	try {
		current = readFileSync(path, "utf8");
	} catch (cause) {
		return { kind: "stranded", reason: `${path} could not be read: ${message(cause)}` };
	}
	if (current !== after) return { kind: "stranded", reason: `${path} changed since the claim was written` };
	try {
		replace(path, before);
	} catch (cause) {
		return { kind: "stranded", reason: message(cause) };
	}
	return { kind: "released" };
}

/**
 * Writes `content` over the ticket, in place.
 *
 * In place rather than by renaming a complete file over it. A rename is atomic, so an interrupted
 * write cannot leave a half-written ticket — but it replaces the file rather than its contents, and
 * everything the file was goes with it: mode, ownership, ACLs, extended attributes, any hard link.
 * A group-writable ticket in a shared effort came back private to whoever claimed it. Writing in
 * place keeps all of that, because it changes the contents of the file that is already there.
 *
 * The window a rename closes is covered anyway. A write that fails partway leaves a ticket the reader
 * cannot parse, the read-back after this refuses it, and the rollback puts the previous text back —
 * the same path every other unverifiable claim takes. So the trade is a failure mode that is caught
 * against three that were not: a symlink at the working path writing through to whatever it pointed
 * at, the file's own metadata discarded on every claim, and debris from an interrupted run needing a
 * rule of its own.
 */
function replace(path: string, content: string): void {
	try {
		// A symlinked ticket is out of contract: writing through it would claim a file the effort does
		// not own, and leave whoever shares that file reading a ticket they never claimed.
		if (lstatSync(path).isSymbolicLink()) {
			throw new ClaimError(`${path} is a symlink; a ticket file has to be the file itself`, "ticket-set");
		}
		writeFileSync(path, content);
	} catch (cause) {
		if (cause instanceof ClaimError) throw cause;
		throw new ClaimError(`${path} could not be written: ${message(cause)}`, filesystemKind(cause), { cause });
	}
}

/**
 * The filesystem failures a later run may simply not hit: a ticket that has gone, so the set has moved
 * and the next run picks something else, and the momentary ones a busy machine produces.
 *
 * A full disk and an exceeded quota are deliberately absent. They do not clear themselves either, and
 * retrying one wedges a caller polling for work on the same unclaimable pick forever, because the
 * ranking hands back the same winner every time.
 *
 * An unrecognised code counts as permanent. Both answers are loud, so the only question is whether a
 * caller retries, and stopping on something nobody has classified is the direction that gets it looked
 * at rather than spun on.
 */
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
	"ENOENT",
	"EAGAIN",
	"EINTR",
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ESTALE",
	"ETIMEDOUT",
]);

function filesystemKind(cause: unknown): ClaimError["kind"] {
	const code = (cause as NodeJS.ErrnoException | null)?.code;
	return code !== undefined && RETRYABLE_FAILURES.has(code) ? "unavailable" : "ticket-set";
}

function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new ClaimError(`${path} could not be read: ${message(cause)}`, filesystemKind(cause), { cause });
	}
}

/** A refusal from the markdown grammar, which says the ticket is wrong rather than busy. */
function asTicketSetFailure<T>(path: string, read: () => T): T {
	try {
		return read();
	} catch (cause) {
		if (cause instanceof ClaimError) throw cause;
		throw new ClaimError(`${path} could not be claimed: ${message(cause)}`, "ticket-set", { cause });
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
