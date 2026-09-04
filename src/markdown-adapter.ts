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

/**
 * One parsed file: the ticket, and what its `Status:` says about its openness *to a dependent*.
 * `openness` is `null` where the status confirms neither — the value is deliberately kept off the
 * ticket surface, because it answers "was this dependency met?" rather than anything a consumer of
 * the ticket asks.
 */
interface ParsedFile {
	readonly ticket: UnresolvedTicket;
	readonly openness: boolean | null;
}

const SCRATCH_DIR = ".scratch";
const MAP_FILE = "map.md";
const ISSUES_DIR = "issues";

const TICKET_FILENAME = /^(\d+)-.*\.md$/;
const TITLE_LINE = /^#\s+(.*\S)\s*$/;
// The number already comes from the filename, so a title repeating it is a duplicate rather than
// part of the title. `to-tickets` writes the em dash form; the en dash and hyphen are accepted
// because nothing constrains a hand-written title to match it. Whitespace is required on at least
// one side of the dash, or the pattern eats the first word of a title that legitimately starts with
// a number — "3-way merge conflict resolution" became "way merge conflict resolution".
const TITLE_NUMBER_PREFIX = /^\d+(?:\s+[—–-]\s*|\s*[—–-]\s+)/;
const SECTION_HEADING = /^#{2,}\s/;
// A setext underline makes the line above it a heading, and a thematic break divides sections just as
// visibly. Recognising only ATX `##` left a whole body inside the header region, where prose reading
// `Status: resolved` became the ticket's own state and pruned its dependents. Only applied once the
// title is in hand, so a leading `---` frontmatter fence cannot end the header before it begins.
const SETEXT_OR_BREAK = /^(?:={3,}|-{3,}|\*{3,}|_{3,})$/;
const CODE_FENCE = /^(?:```|~~~)/;
const FIELD_LINE = /^(Type|Status|Blocked by)\s*:\s*(.*?)\s*$/i;
// A field is commonly written as a list item or inside a blockquote; the anchored FIELD_LINE misses
// both, and a missed `Blocked by:` reads as no blockers at all. Only `Blocked by:` is read through
// this, never `Status:` or `Type:` — see readHeader for why the asymmetry runs that way.
const LINE_DECORATION = /^(?:[-*+]|\d+\.|>)\s+/;
// A markdown indented code block. Four spaces or a tab, before the line is trimmed.
const INDENTED_CODE = /^(?: {4,}|\t)/;
// Any remaining shape that names ticket numbers as a dependency — a table row, a hyphenated or
// renamed field, a missing colon. Each was a silent drop: the shape matched no field, so its blockers
// were neither read nor refused.
//
// Anchored, and applied only after a title has been claimed, because matching the phrase anywhere on
// any line made ordinary prose ("we were blocked by 3 teams") and ordinary titles ("Blocked by 3
// upstream changes") abort the whole effort — the mirror of the bug it exists to prevent, presenting
// as the same "no work available".
// No digit is required: a declaration whose numbers sit on the lines below it ("Blocked by the
// tickets listed below:", or a `## Blocked by` heading) has none on its own line, and those read as
// no blockers at all. The anchor is what keeps prose out — a sentence merely mentioning being
// blocked does not begin with the field's name.
const UNREADABLE_BLOCKER_FIELD = /^(?:blocked[\s-]*by|blockers?|depends[\s-]*on)\b/i;
// Stripped before the guard so a table row and a heading are both reachable by it.
const GUARD_PREFIX = /^(?:\||#{1,6})\s*/;
// `to-tickets` writes "None — can start immediately" where a ticket has no blockers, so the trailing
// commentary is allowed — but only after a dash. Matching the bare `none` prefix instead swallowed
// the rest of the value, so "None directly, but 2 must land first" read as no blockers at all.
const NO_BLOCKERS = /^none\s*(?:[—–-].*)?$/i;

/**
 * The two `Status:` vocabularies that reach this adapter, mapped onto the one open/closed truth.
 * Per the spec's markdown-format survey (nichenke/nextup issue 2), the ticket sets on disk used only
 * `open` and `resolved`, and `claimed` is specified with no observed instances — which is why it is
 * supported here without being assumed. The triage roles are the five in `docs/agents/triage-labels.md`, which the
 * local-markdown convention records in this same `Status:` line — and `to-tickets` writes one of
 * them, `ready-for-agent`, on every actionable ticket it generates. Recognising only the first
 * vocabulary would classify a whole to-tickets-generated effort as unrecognised and yield no
 * candidates at all, a failure that presents as "no work available".
 *
 * A `Map`, not an object literal, because the lookup key is arbitrary file content. Indexing an
 * object literal with `Status: constructor` or `Status: __proto__` answers from `Object.prototype`,
 * so the value read as recognised, `state` came back `undefined`, and a blocker seeded as confirmed
 * closed — the guard against the forbidden collapse was the thing delivering it. `Object.hasOwn`
 * would also close it; a `Map` has no prototype chain to reach in the first place.
 */
const STATUS_VOCABULARY = new Map<string, StatusReading>([
	["open", { state: "open", claimed: false, met: false, label: null }],
	["claimed", { state: "open", claimed: true, met: false, label: null }],
	["resolved", { state: "closed", claimed: false, met: true, label: null }],
	["ready-for-agent", { state: "open", claimed: false, met: false, label: "ready-for-agent" }],
	["ready-for-human", { state: "open", claimed: false, met: false, label: "ready-for-human" }],
	["needs-triage", { state: "open", claimed: false, met: false, label: "needs-triage" }],
	["needs-info", { state: "open", claimed: false, met: false, label: "needs-info" }],
	["wontfix", { state: "closed", claimed: false, met: false, label: "wontfix" }],
]);

// `readStatus` hands back the object stored in the vocabulary rather than a copy, so a caller
// assigning to a field would rewrite the vocabulary for the rest of the process.
interface StatusReading {
	readonly state: "open" | "closed";
	readonly claimed: boolean;
	/**
	 * Whether closing this way tells a dependent that what it was waiting for actually happened.
	 * Not the negation of `state`: the convention keys blocking on `resolved` specifically — "a
	 * ticket is unblocked when every file it lists is `resolved`" — so `wontfix` is closed, and
	 * therefore no candidate, while saying nothing about whether the dependency was met. Deriving
	 * this from `state` prunes an abandoned blocker as satisfied and reports work as ready to start
	 * on a foundation never built.
	 */
	readonly met: boolean;
	/**
	 * The triage label this value maps to, per `docs/agents/triage-labels.md`, or `null` where it is
	 * a wayfinder state rather than a triage role. Without it the role is consumed into open/closed
	 * and lost, leaving `needs-info` indistinguishable from `open` and the candidate-set label
	 * filter with nothing to act on.
	 */
	readonly label: string | null;
}

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
	return listDirectory(scratch)
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

	const parsed = readTicketFiles(join(effortRoot, ISSUES_DIR));
	parsed.sort((a, b) => Number(a.ticket.ref.key) - Number(b.ticket.ref.key));

	requireNoBlockingCycle(parsed, effortRoot);

	const identified = parsed.map((file) => ({ ...file, id: ticketId(file.ticket.ref) }));

	const store = emptyGraphStore();
	for (const { ticket, openness, id } of identified) {
		// Markdown has no containment relation, so every ticket is a confirmed root. Leaving the key
		// absent instead would read as "unknown", and no ticket here could then ever read
		// "unblocked" — a confirmed open blocker would still win, so the damage is silent.
		store.parents.set(id, null);
		if (openness !== null) store.openness.set(id, openness);
		store.blockers.set(id, ticket.blockers.map(ticketId));
	}
	// Two things deliberately seed no openness and so read "unknown": a `Blocked by:` reference to a
	// number no file in this effort carries, and a ticket closed without its dependency being met.
	// Both degrade their dependents to unknown rather than to unblocked.
	const graph = buildGraph(store);

	return {
		root: effortRoot,
		graph,
		tickets: identified.map(({ ticket, id }) => ({
			...ticket,
			blocked: deriveEffectiveBlockedness(id, graph),
		})),
	};
}

/**
 * A blocking cycle can never resolve, so every ticket in it reads `blocked` forever. The traversal
 * handles that safely — it errs toward blocked, not toward unblocked — but nothing downstream can
 * tell a deadlock apart from a backlog that is merely all blocked, so it surfaces as "no work
 * available" with no explanation. Naming it here is the only place the whole effort is in view.
 */
function requireNoBlockingCycle(parsed: readonly ParsedFile[], effortRoot: string): void {
	const edges = new Map(parsed.map(({ ticket }) => [ticket.ref.key, ticket.blockers.map((b) => b.key)]));
	const settled = new Set<string>();
	const onPath = new Set<string>();

	const walk = (key: string, path: readonly string[]): void => {
		if (settled.has(key)) return;
		if (onPath.has(key)) {
			const cycle = [...path.slice(path.indexOf(key)), key].join(" -> ");
			throw new MarkdownEffortError(`${effortRoot} has a blocking cycle that can never resolve: ${cycle}`);
		}
		onPath.add(key);
		// A reference to a number no file carries is a dangling edge, not a cycle; it is left to
		// resolve as unknown in the graph.
		for (const blocker of edges.get(key) ?? []) walk(blocker, [...path, key]);
		onPath.delete(key);
		settled.add(key);
	};

	for (const key of edges.keys()) walk(key, []);
}

function readTicketFiles(issuesDir: string): ParsedFile[] {
	const parsed: ParsedFile[] = [];
	const seen = new Map<string, string>();

	for (const name of listDirectory(issuesDir).sort()) {
		// macOS writes .DS_Store into any directory the Finder has opened, unbidden.
		if (name.startsWith(".")) continue;
		const path = join(issuesDir, name);
		if (!isReadableFile(path)) continue;

		const named = TICKET_FILENAME.exec(name);
		if (named?.[1] === undefined) {
			throw new MarkdownEffortError(`${path} is not a numbered ticket file (expected <NN>-<slug>.md)`);
		}
		const file = parseTicketFile(readTicketText(path), path, named[1]);
		const collision = seen.get(file.ticket.ref.key);
		if (collision !== undefined) {
			throw new MarkdownEffortError(`${path} and ${collision} are both ticket ${file.ticket.ref.key}`);
		}
		seen.set(file.ticket.ref.key, path);
		parsed.push(file);
	}
	return parsed;
}

// Everything below converts a filesystem failure into this module's own error. `existsSync` is true
// for a plain file, so a `.scratch` or `issues` that is a file rather than a directory reaches
// `readdirSync` and throws ENOTDIR; a symlink loop reaches `statSync` and throws ELOOP; an unreadable
// file reaches `readFileSync` and throws EACCES. A caller catching `MarkdownEffortError` to report
// "not an effort" sees any of those escape as an unhandled errno instead.
function listDirectory(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (cause) {
		throw new MarkdownEffortError(`${dir} could not be listed as a directory: ${describe(cause)}`);
	}
}

/**
 * Whether this entry is a file worth parsing. A missing entry is skipped rather than refused — a
 * dangling symlink, or a file removed between the listing and this call, is directory junk, and a
 * ticket that vanishes is at worst a dangling blocker reference, which resolves as unknown. Any other
 * failure is refused, because it says the effort cannot be read rather than that an entry is absent.
 */
function isReadableFile(path: string): boolean {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
	} catch (cause) {
		throw new MarkdownEffortError(`${path} could not be inspected: ${describe(cause)}`);
	}
}

function readTicketText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new MarkdownEffortError(`${path} could not be read: ${describe(cause)}`);
	}
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function parseTicketFile(text: string, path: string, number: string): ParsedFile {
	const { title, fields } = readHeader(text, path);
	if (title === null) {
		throw new MarkdownEffortError(`${path} has no H1 title`);
	}

	const status = readStatus(fields.get("status"), path);
	const ref = requireTicketNumber(number, path);
	const blockers = parseBlockers(fields.get("blocked by"), path);
	if (blockers.some((blocker) => blocker.key === ref.key)) {
		throw new MarkdownEffortError(`${path} lists itself as its own blocker, which can never resolve`);
	}

	const type = fields.get("type");
	return {
		openness: opennessOf(status),
		ticket: {
			ref,
			title,
			state: status.state,
			claim: status.claimed ? { by: null } : null,
			blockers,
			url: null,
			// The triage role, where the Status carried one. `Type:` is deliberately not mapped onto a
			// label: per CONTEXT.md's **Wayfinder ticket**, the label filter partitions the two tracks,
			// and for markdown that provenance is a property of the effort's map file rather than of a
			// ticket's kind — so deriving a `wayfinder:*` label from `Type:` would put every ticket in
			// an effort on the wayfinder side of a partition the map is supposed to decide.
			labels: status.label === null ? [] : [status.label],
			type: type === undefined || type === "" ? null : type,
			path,
		},
	};
}

// A filename number the reference grammar rejects — "0-a.md" — is still a malformed effort rather
// than a malformed reference, so it fails as this module's error like every other file-shape defect.
function requireTicketNumber(number: string, path: string): TicketRef {
	try {
		return resolveTicketRef(`md:${number}`);
	} catch (cause) {
		if (!(cause instanceof TicketRefError)) throw cause;
		throw new MarkdownEffortError(`${path} is numbered ${number}, which is not a valid ticket number`);
	}
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
		const bare = raw.replace(/\*\*/g, "");
		const line = bare.trim();
		// A `to-tickets` ticket has no section heading at all, so its whole body is header region, and
		// that skill inlines a code snippet where one encodes a decision. A field-shaped line in a
		// fenced snippet is not this ticket's field. A fenced `##` is not a section heading either, so
		// the fence is resolved before the heading that ends the header. Only *fenced* blocks are
		// tracked: an indented block's fields are read as real, which errs toward `blocked`.
		if (CODE_FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		// The title is claimed before the declaration guard runs, so a title that happens to read
		// "Blocked by 3 upstream changes" is a title rather than a malformed field.
		const heading = TITLE_LINE.exec(line);
		if (heading?.[1] !== undefined) {
			if (pastHeader) continue;
			if (title !== null) {
				throw new MarkdownEffortError(`${path} has more than one H1 title`);
			}
			title = heading[1].replace(TITLE_NUMBER_PREFIX, "");
			continue;
		}

		const undecorated = line.replace(LINE_DECORATION, "");
		const decorated = undecorated !== line;
		const indentedCode = INDENTED_CODE.test(bare);
		const field = FIELD_LINE.exec(undecorated);
		const isBlockedBy = field?.[1]?.toLowerCase() === "blocked by";

		// An indented block is markdown's other code block, so a field in one is an example, not this
		// ticket's. `Status:` is ignored in that case; `Blocked by:` cannot be, so it is refused.
		if (isBlockedBy && indentedCode) {
			throw new MarkdownEffortError(
				`${path} has an indented Blocked by line; markdown reads that as a code block, and a blocker declaration must not sit in one — unindent it, or fence it if it is an example`,
			);
		}

		// The guard runs before the section-heading branch, because `## Blocked by` with its numbers
		// listed underneath is a declaration too, and a branch that skipped headings first left it
		// silently reading as no blockers.
		if (!isBlockedBy && UNREADABLE_BLOCKER_FIELD.test(line.replace(GUARD_PREFIX, "").replace(LINE_DECORATION, ""))) {
			throw new MarkdownEffortError(
				`${path} names blockers in a shape this parser cannot read ("${line}"); write it as a "Blocked by: <numbers>" line above the first section heading, or fence it if it is prose`,
			);
		}

		if (SECTION_HEADING.test(line) || (title !== null && SETEXT_OR_BREAK.test(line))) {
			pastHeader = true;
			continue;
		}

		if (pastHeader) {
			if (isBlockedBy) {
				throw new MarkdownEffortError(
					`${path} has a Blocked by line below a section heading, where it would be read as no blockers at all; move it above the first heading, or fence it if it is prose`,
				);
			}
			continue;
		}

		if (field?.[1] === undefined) continue;
		const key = field[1].toLowerCase();

		// The asymmetry, and the direction matters. A `Blocked by:` is read through a list marker or a
		// blockquote, because dropping one reads a confident `unblocked` — the state `CONTEXT.md`
		// forbids ever inferring — and it is refused above if the shape is unreadable. A `Status:` gets
		// no such allowance: people quote a status when recording that something *completed*, so a
		// decorated or indented `Status: resolved` read as the ticket's own would seed a confirmed-met
		// blocker and prune its dependents. Ignoring it instead leaves the ticket open and unclaimed,
		// which a human sees at the confirmation gate.
		if (key !== "blocked by" && (decorated || indentedCode)) continue;
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

function readStatus(value: string | undefined, path: string): StatusReading {
	// The wayfinder convention records only `claimed` and `resolved`, so an absent Status line is
	// how an open, unclaimed ticket is written.
	if (value === undefined || value === "") {
		return { state: "open", claimed: false, met: false, label: null };
	}

	const known = STATUS_VOCABULARY.get(value.toLowerCase());
	if (known === undefined) {
		throw new MarkdownEffortError(
			`${path} has Status: ${value}, which is not a recognised status (${[...STATUS_VOCABULARY.keys()].join(", ")})`,
		);
	}
	return known;
}

/**
 * What to seed as this ticket's openness *to a dependent*, or `null` to leave it unconfirmed so the
 * traversal reads `"unknown"`. See `StatusReading.met` for why closed is not the same as satisfied.
 */
function opennessOf(status: StatusReading): boolean | null {
	if (status.state === "open") return true;
	return status.met ? false : null;
}

// What counts as a markdown ticket number is `resolveTicketRef`'s to define, so a blocker token is
// validated by trying to resolve it rather than by a second regex here. A local copy of that rule
// drifted from it silently: the two agreed only for as long as someone remembered both.
function parseBlockers(value: string | undefined, path: string): TicketRef[] {
	// No field states no blockers. A field with nothing after the colon states nothing, and is how a
	// declaration whose numbers were written on the following lines presents — those lines match no
	// field, so treating the empty value as "none" discards a payload the parser plainly saw.
	if (value === undefined) return [];
	if (value === "") {
		throw new MarkdownEffortError(
			`${path} has an empty Blocked by field; list the ticket numbers on that line, or write "None" if there are none`,
		);
	}
	if (NO_BLOCKERS.test(value)) return [];
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
