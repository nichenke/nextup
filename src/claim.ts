import { accessSync, constants, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type MarkdownTicketFile, parseTicketText, readTicketFile, withStatus } from "./markdown-adapter";
import type { Claim } from "./ticket";
import { type ResolveDeps, type TicketRef, formatTicketRef } from "./ticket-ref";

/**
 * Why a claim could not be taken. `kind` separates the two answers a caller owes different things to:
 * `"unavailable"` is the tracker's answer about this ticket right now, and `"ticket-set"` says the
 * ticket itself is wrong, which no amount of waiting fixes.
 */
export class ClaimError extends Error {
	readonly kind: "unavailable" | "ticket-set";

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
 * What became of a claim asked to give itself back. Three answers rather than a boolean because a
 * caller acts differently on each: `stranded` leaves a real claim on a ticket nobody is working, and
 * is the only one worth escalating; `nothing-to-release` says there was never a claim to give back.
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
			replace(path, after, before);

			// Verified through the reader the selector was fed, so a claim counts as landed only when it
			// is one that reads back as a claim. Anything else rolls the file back, or says it could not,
			// because a half-written claim advertises the ticket as neither taken nor free.
			let verified: MarkdownTicketFile;
			try {
				verified = asTicketSetFailure(path, () => readBack(path));
			} catch (cause) {
				throw rollingBack(path, after, before, cause);
			}
			if (verified.claim === null) {
				const refusal = new ClaimError(
					`${formatTicketRef(ticket.ref)} does not read as claimed after being claimed`,
					"unavailable",
				);
				throw rollingBack(path, after, before, refusal);
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
 * Reports `cause` for a claim whose rollback has been attempted, naming a claim the rollback could not
 * take back. Told only that the claim did not verify, a caller would not know one is outstanding — and
 * a claim left on a ticket nobody is working is the failure this whole step exists to avoid.
 *
 * Both rollback sites go through here rather than each remembering to look at the outcome, which is
 * how the first of them came to discard it.
 */
function rollingBack(path: string, after: string, before: string, cause: unknown): ClaimError {
	const failure = cause instanceof ClaimError ? cause : new ClaimError(message(cause), "unavailable", { cause });
	const outcome = revert(path, after, before);
	if (outcome.kind !== "stranded") return failure;
	// Unavailable whatever the first failure was: there is now a claim to go and clear, which is the
	// answer that code is for.
	return new ClaimError(`${failure.message}; the claim was not taken back either: ${outcome.reason}`, "unavailable", {
		cause: failure,
	});
}

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
		replace(path, before, after);
	} catch (cause) {
		return { kind: "stranded", reason: message(cause) };
	}
	return { kind: "released" };
}

/**
 * Writes `content` by renaming a complete file over the old one, so a failed or interrupted write
 * leaves the ticket as it was. Writing in place opens with O_TRUNC, which empties the file before the
 * first byte lands — and this is the one step whose failure has nothing left to restore from.
 *
 * A scratch file already at that name is overwritten. Only this process ever writes one, so it can
 * only be debris from a claim that died mid-write, and refusing would turn that into a ticket nobody
 * can claim until somebody deletes a file by hand.
 *
 * @param recover what the file should still hold if the rename never happens, used only in the message.
 */
function replace(path: string, content: string, recover: string): void {
	const scratch = `${path}.nextup`;
	// The two ways renaming differs from writing in place, both checked rather than inferred.
	//
	// A rename needs permission on the directory and none on the file, so a read-only ticket would
	// otherwise be rewritten by a step that never asked. And a rename replaces a symlink rather than
	// following it, which would leave the effort holding a regular file while the shared target still
	// read unclaimed — a ticket handed out twice, which is the one thing `Claim` exists to prevent.
	// Symlinked ticket files are out of contract, so this refuses rather than resolving them.
	if (lstatSync(path).isSymbolicLink()) {
		throw new ClaimError(`${path} is a symlink; a ticket file has to be the file itself`, "ticket-set");
	}
	try {
		accessSync(path, constants.W_OK);
		writeFileSync(scratch, content);
		renameSync(scratch, path);
	} catch (cause) {
		rmSync(scratch, { force: true });
		const held = content === recover ? "" : `; ${path} still holds what it did before`;
		throw new ClaimError(`${path} could not be written: ${message(cause)}${held}`, filesystemKind(cause), {
			cause,
		});
	}
}

/**
 * Which of the two answers a filesystem failure is. A ticket that has gone is a changed ticket set, so
 * another run picks something else and this reports it as unavailable. Anything else — a permission, a
 * read-only mount, a full disk — stays wrong until somebody fixes it, and calling that unavailable
 * wedges a caller polling for work on the same unclaimable pick forever.
 */
function filesystemKind(cause: unknown): ClaimError["kind"] {
	return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "unavailable" : "ticket-set";
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
