import { readFileSync, writeFileSync } from "node:fs";
import { type MarkdownTicketFile, readTicketFile, withStatus } from "./markdown-adapter";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

export class ClaimError extends Error {}

/**
 * A claim that landed. `claimant` is who the tracker records as holding it, and `null` where the
 * tracker records only that one is held — markdown's case, since a `Status:` line has nowhere to put a
 * name. Reading that `null` as "nobody" is what would hand the ticket out twice.
 */
export interface ClaimHold {
	readonly ref: TicketRef;
	readonly claimant: string | null;
}

/**
 * Whether a claim was given back. A failure is reported rather than thrown because a release runs on
 * the way out of an earlier failure, and throwing there replaces the reason the caller was already
 * reporting with a second one.
 */
export type ReleaseOutcome = { readonly released: true } | { readonly released: false; readonly reason: string };

/**
 * The write half of one tracker, holding a single ticket's claim. Stateful on purpose: a release has
 * to put back exactly what the claim overwrote, and only the object that wrote it knows that.
 *
 * Best-effort by design, per the spec — no compare-and-swap and no expiry. A ticket left claimed with
 * nothing running is visible and correctable by hand, which is cheaper than machinery that would have
 * to be right on four trackers.
 */
export interface Claimer {
	/** @throws ClaimError when the claim could not be written, or could not be confirmed afterwards. */
	claim(): ClaimHold;
	release(): ReleaseOutcome;
}

/** What markdown's `Status:` line says while a ticket is being worked. */
const CLAIMED = "claimed";

export interface MarkdownClaimDeps {
	/**
	 * Re-reads the file the claim was written to. A parameter because the failure it guards — a write
	 * that lands and still reads back unclaimed — is a race against another writer, which nothing can
	 * stage from outside the process. It stands in for the same event on a real tracker: GitHub accepts
	 * an assignment to a user without repository access and hands the issue back unassigned.
	 */
	readonly readBack?: (path: string) => MarkdownTicketFile;
}

/**
 * Claims a markdown ticket by writing `claimed` into its `Status:` field, which is the only claim
 * signal the format has. The field also carries the ticket's state and its triage role, so the claim
 * overwrites whichever of those was there — `docs/adr/0012-claiming-overwrites-the-markdown-status.md`
 * records why that is accepted and what it costs.
 *
 * The ticket is re-read before anything is written, so a ticket claimed or closed between selection
 * and here is refused rather than taken from whoever got there first.
 */
export function markdownClaimer(ticket: MarkdownTicketFile, deps: MarkdownClaimDeps = {}): Claimer {
	const readBack = deps.readBack ?? readTicketFile;
	const path = ticket.path;
	let written: { readonly before: string; readonly after: string } | null = null;

	return {
		claim(): ClaimHold {
			if (written !== null) throw new ClaimError(`${formatTicketRef(ticket.ref)} is already claimed by this run`);

			const before = onFile(path, "read", () => readFileSync(path, "utf8"));
			const current = reread(readBack, path);
			if (current.state === "closed") {
				throw new ClaimError(`${formatTicketRef(ticket.ref)} closed since it was selected; nothing was claimed`);
			}
			if (current.claim !== null) {
				throw new ClaimError(`${formatTicketRef(ticket.ref)} was claimed since it was selected; nothing was claimed`);
			}

			const after = withStatus(before, CLAIMED, path);
			onFile(path, "written", () => writeFileSync(path, after));

			// Verified through the reader the selector was fed, so a claim counts as landed only when it
			// is one that reads back as a claim. Anything else puts the file back, because a half-written
			// claim advertises the ticket as neither taken nor free.
			let verified: MarkdownTicketFile;
			try {
				verified = reread(readBack, path);
			} catch (cause) {
				restore(path, before);
				throw cause;
			}
			if (verified.claim === null) {
				restore(path, before);
				throw new ClaimError(`${formatTicketRef(ticket.ref)} does not read as claimed after being claimed`);
			}

			written = { before, after };
			return { ref: ticket.ref, claimant: null };
		},

		release(): ReleaseOutcome {
			const claim = written;
			if (claim === null) return { released: false, reason: "nothing was claimed" };
			let current: string;
			try {
				current = readFileSync(path, "utf8");
			} catch (cause) {
				return { released: false, reason: `${path} could not be read: ${message(cause)}` };
			}
			// An edit made since the claim is somebody's work, and putting the file back would discard it.
			// A ticket left claimed is the visible failure; a lost edit is the invisible one.
			if (current !== claim.after) {
				return { released: false, reason: `${path} changed since the claim was written` };
			}
			try {
				writeFileSync(path, claim.before);
			} catch (cause) {
				return { released: false, reason: `${path} could not be written: ${message(cause)}` };
			}
			written = null;
			return { released: true };
		},
	};
}

function reread(readBack: (path: string) => MarkdownTicketFile, path: string): MarkdownTicketFile {
	try {
		return readBack(path);
	} catch (cause) {
		throw new ClaimError(`${path} could not be read: ${message(cause)}`, { cause });
	}
}

/** A best-effort undo of a claim that did not verify; the caller is already reporting a failure. */
function restore(path: string, before: string): void {
	try {
		writeFileSync(path, before);
	} catch {
		// Nothing to add: the claim failure about to be thrown is the reason the caller reports, and a
		// second failure here cannot change what it has to do.
	}
}

function onFile<T>(path: string, verb: string, act: () => T): T {
	try {
		return act();
	} catch (cause) {
		throw new ClaimError(`${path} could not be ${verb}: ${message(cause)}`, { cause });
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
