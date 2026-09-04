import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BlockedState, type DependencyGraph, deriveEffectiveBlockedness } from "./effective-blockedness";
import { buildGraph, emptyGraphStore } from "./graph-store";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, TicketRefError, resolveTicketRef } from "./ticket-ref";

export class MarkdownEffortError extends Error {}

/**
 * A markdown ticket, plus what only the file it came from can say. `blockers` narrows `Ticket`'s
 * tri-state to a list, which is honest only because every shape this parser cannot read is refused:
 * a `Blocked by:` line it would otherwise drop throws instead, so "no blockers" is always a
 * declaration and never an absence of evidence.
 */
export interface MarkdownTicket extends Ticket {
	readonly blockers: readonly TicketRef[];
	/** Path of the file this ticket was parsed from, resolved from the effort root as given. */
	readonly path: string;
	/** The `Type:` field — the wayfinder ticket kind. Absent from `to-tickets` output. */
	readonly type: string | null;
	readonly blocked: BlockedState;
}

export interface MarkdownEffort {
	readonly root: string;
	/** Ordered by ticket number ascending. */
	readonly tickets: readonly MarkdownTicket[];
	readonly graph: DependencyGraph;
}

type UnresolvedTicket = Omit<MarkdownTicket, "blocked">;

const SCRATCH_DIR = ".scratch";
const MAP_FILE = "map.md";
const ISSUES_DIR = "issues";

const TICKET_FILENAME = /^(\d+)-.*\.md$/;
const TITLE_LINE = /^#\s+(.*\S)\s*$/;
// The number already comes from the filename, so a title repeating it is a duplicate rather than
// part of the title. `to-tickets` writes the em dash form; the en dash and hyphen are accepted
// because nothing constrains a hand-written title to match it.
const TITLE_NUMBER_PREFIX = /^\d+\s*[—–-]\s*/;
const SECTION_HEADING = /^#{2,}\s/;
const CODE_FENCE = /^(?:```|~~~)/;
const FIELD_LINE = /^(Type|Status|Blocked by)\s*:\s*(.*?)\s*$/i;
// `to-tickets` writes "None — can start immediately" where a ticket has no blockers.
const NO_BLOCKERS = /^none\b/i;

/**
 * The two `Status:` vocabularies that reach this adapter, mapped onto the one open/closed truth.
 * Per the spec's markdown-format survey (nichenke/nextup issue 2), the ticket sets on disk used only
 * `open` and `resolved`, and `claimed` is specified with no observed instances — which is why it is
 * supported here without being assumed. The triage roles are the five in `docs/agents/triage-labels.md`, which the
 * local-markdown convention records in this same `Status:` line — and `to-tickets` writes one of
 * them, `ready-for-agent`, on every actionable ticket it generates. Recognising only the first
 * vocabulary would classify a whole to-tickets-generated effort as unrecognised and yield no
 * candidates at all, a failure that presents as "no work available".
 */
const STATUS_VOCABULARY: Record<string, { state: "open" | "closed"; claimed: boolean }> = {
	open: { state: "open", claimed: false },
	claimed: { state: "open", claimed: true },
	resolved: { state: "closed", claimed: false },
	"ready-for-agent": { state: "open", claimed: false },
	"ready-for-human": { state: "open", claimed: false },
	"needs-triage": { state: "open", claimed: false },
	"needs-info": { state: "open", claimed: false },
	wontfix: { state: "closed", claimed: false },
};

/**
 * What makes a directory an effort, defined once: `discoverEfforts` skips anything this rejects and
 * `readEffort` refuses it, so the two cannot come to disagree about what they are looking at.
 */
function isEffortRoot(root: string): boolean {
	return existsSync(join(root, MAP_FILE)) && existsSync(join(root, ISSUES_DIR));
}

/** Effort directories under `<repoRoot>/.scratch`. */
export function discoverEfforts(repoRoot: string): string[] {
	const scratch = join(repoRoot, SCRATCH_DIR);
	if (!existsSync(scratch)) return [];
	return readdirSync(scratch)
		.sort()
		.map((name) => join(scratch, name))
		.filter(isEffortRoot);
}

export function readEffort(effortRoot: string): MarkdownEffort {
	if (!isEffortRoot(effortRoot)) {
		throw new MarkdownEffortError(
			`${effortRoot} is not an effort: it must hold both ${MAP_FILE} and an ${ISSUES_DIR}/ directory`,
		);
	}

	const unresolved = readTicketFiles(join(effortRoot, ISSUES_DIR));
	unresolved.sort((a, b) => Number(a.ref.key) - Number(b.ref.key));

	const store = emptyGraphStore();
	for (const ticket of unresolved) {
		const id = ticketId(ticket.ref);
		// Markdown has no containment relation, so every ticket is a confirmed root. Leaving the key
		// absent instead would read as "unknown", and no ticket here could then ever read
		// "unblocked" — a confirmed open blocker would still win, so the damage is silent.
		store.parents.set(id, null);
		store.openness.set(id, ticket.state === "open");
		store.blockers.set(id, ticket.blockers.map(ticketId));
	}
	// A `Blocked by:` reference to a number no file in this effort carries seeds no openness, so it
	// reads "unknown" and its dependents degrade to unknown rather than to unblocked.
	const graph = buildGraph(store);

	return {
		root: effortRoot,
		graph,
		tickets: unresolved.map((ticket) => ({
			...ticket,
			blocked: deriveEffectiveBlockedness(ticketId(ticket.ref), graph),
		})),
	};
}

function readTicketFiles(issuesDir: string): UnresolvedTicket[] {
	const tickets: UnresolvedTicket[] = [];
	const seen = new Map<string, string>();

	for (const name of readdirSync(issuesDir).sort()) {
		// macOS writes .DS_Store into any directory the Finder has opened, unbidden.
		if (name.startsWith(".")) continue;
		const path = join(issuesDir, name);
		if (!statSync(path).isFile()) continue;

		const named = TICKET_FILENAME.exec(name);
		if (named?.[1] === undefined) {
			throw new MarkdownEffortError(`${path} is not a numbered ticket file (expected <NN>-<slug>.md)`);
		}
		const ticket = parseTicketFile(readFileSync(path, "utf8"), path, named[1]);
		const collision = seen.get(ticket.ref.key);
		if (collision !== undefined) {
			throw new MarkdownEffortError(`${path} and ${collision} are both ticket ${ticket.ref.key}`);
		}
		seen.set(ticket.ref.key, path);
		tickets.push(ticket);
	}
	return tickets;
}

function parseTicketFile(text: string, path: string, number: string): UnresolvedTicket {
	const { title, fields } = readHeader(text, path);
	if (title === null) {
		throw new MarkdownEffortError(`${path} has no H1 title`);
	}

	const status = readStatus(fields.get("status"), path);
	return {
		ref: resolveTicketRef(`md:${number}`),
		title,
		state: status.state,
		claim: status.claim,
		blockers: parseBlockers(fields.get("blocked by") ?? "", path),
		url: null,
		// `Type:` is the ticket's kind and is deliberately not mapped onto a label. Per CONTEXT.md's
		// **Wayfinder ticket**, the label filter partitions the two tracks, and for markdown that
		// provenance is a property of the effort's map file rather than of a ticket's kind — so
		// deriving a `wayfinder:*` label from `Type:` would put every ticket in an effort on the
		// wayfinder side of a partition the map is supposed to decide.
		labels: [],
		type: fields.get("type") ?? null,
		path,
	};
}

/**
 * The fields above the first section heading, with the bold form `to-tickets` emits normalized
 * into the plain form real ticket sets use — the bold markers are stripped before matching, so
 * `**Status:** x`, `**Status**: x`, and `Status: x` are one shape by the time it is read.
 */
function readHeader(text: string, path: string): { title: string | null; fields: Map<string, string> } {
	const fields = new Map<string, string>();
	let title: string | null = null;
	let inFence = false;
	let pastHeader = false;

	for (const raw of text.split("\n")) {
		const line = raw.replace(/\*\*/g, "").trim();
		// A `to-tickets` ticket has no section heading at all, so its whole body is header region,
		// and that skill inlines a code snippet where one encodes a decision. A `Status:` line in
		// such a snippet is not this ticket's field. A fenced `##` is not a section heading either,
		// so the fence is resolved before the heading that ends the header.
		if (CODE_FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (SECTION_HEADING.test(line)) {
			pastHeader = true;
			continue;
		}

		const field = FIELD_LINE.exec(line);

		// Below the header, only `Blocked by:` is policed, and the asymmetry is deliberate. A
		// `Status:` line that is missed reads open and unclaimed, which a human sees at launch, and
		// an Answer or Comments section legitimately quotes a past `Status:` value as prose. A
		// `Blocked by:` line that is missed reads a confident `unblocked` — the one state
		// `CONTEXT.md` forbids ever inferring — so it is refused wherever it appears rather than
		// dropped. Fencing the line is the escape hatch for genuinely quoting one.
		if (pastHeader) {
			if (field?.[1]?.toLowerCase() === "blocked by") {
				throw new MarkdownEffortError(
					`${path} has a Blocked by line below a section heading, where it would be read as no blockers at all; move it above the first heading, or fence it if it is prose`,
				);
			}
			continue;
		}

		const heading = TITLE_LINE.exec(line);
		if (heading?.[1] !== undefined) {
			title ??= heading[1].replace(TITLE_NUMBER_PREFIX, "");
			continue;
		}

		if (field?.[1] === undefined) continue;
		const key = field[1].toLowerCase();
		if (fields.has(key)) {
			throw new MarkdownEffortError(`${path} has more than one ${field[1]} field`);
		}
		fields.set(key, field[2] ?? "");
	}

	// An unterminated fence hides every line after it, fields included, with nothing to see.
	if (inFence) {
		throw new MarkdownEffortError(`${path} has an unterminated code fence, which hides any field below it`);
	}
	return { title, fields };
}

function readStatus(value: string | undefined, path: string): { state: "open" | "closed"; claim: Claim | null } {
	// The wayfinder convention records only `claimed` and `resolved`, so an absent Status line is
	// how an open, unclaimed ticket is written.
	if (value === undefined || value === "") return { state: "open", claim: null };

	const known = STATUS_VOCABULARY[value.toLowerCase()];
	if (known === undefined) {
		throw new MarkdownEffortError(
			`${path} has Status: ${value}, which is not a recognised status (${Object.keys(STATUS_VOCABULARY).join(", ")})`,
		);
	}
	return { state: known.state, claim: known.claimed ? { by: null } : null };
}

// What counts as a markdown ticket number is `resolveTicketRef`'s to define, so a blocker token is
// validated by trying to resolve it rather than by a second regex here. A local copy of that rule
// drifted from it silently: the two agreed only for as long as someone remembered both.
function parseBlockers(value: string, path: string): TicketRef[] {
	if (value === "" || NO_BLOCKERS.test(value)) return [];
	return value.split(",").map((entry) => {
		const token = entry.trim();
		try {
			return resolveTicketRef(`md:${token}`);
		} catch (cause) {
			if (!(cause instanceof TicketRefError)) throw cause;
			throw new MarkdownEffortError(
				`${path} has Blocked by listing "${token}", which is not a ticket number in this effort`,
			);
		}
	});
}
