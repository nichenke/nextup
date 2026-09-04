import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BlockedState, type DependencyGraph, deriveEffectiveBlockedness } from "./effective-blockedness";
import { seedGraph } from "./graph-store";
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
	/**
	 * Derived against this effort's graph and valid only alongside it, for the same reason a markdown
	 * `ticketId` is effort-local. A consumer holding tickets from two efforts must re-derive from a
	 * merged graph rather than trust this — `MarkdownEffort.graph` is returned so it can.
	 */
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
 * One parsed file: the ticket, and what its `Status:` says about its openness *to a dependent*. That
 * second value is deliberately kept off the ticket surface, because it answers "was this dependency
 * met?" rather than anything a consumer of the ticket asks.
 */
interface ParsedFile {
	readonly ticket: UnresolvedTicket;
	readonly openness: boolean | "unknown";
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
const TITLE_NUMBER_PREFIX = /^(\d+)(?:\s+[—–-]\s*|\s*[—–-]\s+)/;
const SECTION_HEADING = /^#{2,}\s/;
// The whole accepted field grammar, per ADR-0008: an unindented, undecorated line, plain or bold.
// Deliberately narrow — the only producers writing these files are the wayfinder local-markdown
// convention and the `to-tickets` skill, so widening it buys tolerance nothing needs and costs a new
// way to read a line wrongly.
const FIELD_LINE = /^(Type|Status|Blocked by)\s*:\s*(.*?)\s*$/i;
// Any indent at all disqualifies a field, per the grammar above. Four spaces or a tab additionally
// makes the line a markdown code block, which is what suppresses a fence marker inside one.
const INDENTED = /^[ \t]/;
const INDENTED_CODE = /^(?: {4,}|\t)/;
// Decoration a field must not wear. Stripped only to decide whether to REFUSE a line, never to read
// one: a `Blocked by:` this parser cannot read must be refused rather than dropped, because dropped
// reads as no blockers at all. Anchoring after the strip is what keeps prose out — a sentence
// mentioning being blocked does not begin with the field's name — and no digit is required, since a
// declaration whose numbers sit on the lines below it has none on its own line.
//
// The set is markdown's own line markers, which is what makes it closed: task-list boxes and nested
// prefixes each got a declaration through while the set was guessed from the shapes review happened
// to find. Stripped repeatedly, because `> - Blocked by: 2` wears two and one pass left a marker on.
const LEADING_MARKER = /^(?:[-*+>|]|#{1,6}|\d+\.|\[[ xX]?\])\s*/;
// Any separator between the words, and the near-miss names, for the same reason: `Blocked_by` and
// `Dependencies` were dropped because the pattern spelled the separators and suffixes it had seen.
// One source for both, since spelling the alternation twice is how `Depends on:` came to satisfy the
// name test but not the field test — the second copy stopped at `Depends`.
const BLOCKER_WORDS = "(?:blocked?[\\s_-]*by|blockers?|depend(?:s|encies|ency)?(?:\\s+on)?)";
const BLOCKER_NAME = new RegExp(`^${BLOCKER_WORDS}\\b`, "i");
// The name has to be doing a field's job, not a sentence's. Naming the word alone refused an effort
// over one line of prose in one ticket — "Depends on the spike landing." — which is the same
// "no work available" the refusal exists to prevent, arrived at from the other side.
const BLOCKER_FIELD = new RegExp(`^${BLOCKER_WORDS}\\s*:`, "i");
const HEADING = /^#{1,6}\s/;
const SENTENCE_END = /[.!?]$/;
const BARE_NUMBERS = /^[\s#\d,]*$/;

function undecorate(line: string): string {
	let stripped = line;
	for (let previous = ""; stripped !== previous; ) {
		previous = stripped;
		stripped = stripped.replace(LEADING_MARKER, "");
	}
	return stripped;
}

/**
 * Whether a line names blockers in a shape this parser will not read — which must be refused rather
 * than dropped, since a dropped declaration reads as a confident `unblocked`.
 *
 * Each clause is a way of being structurally a field rather than a sentence, and that distinction is
 * the whole point: the name alone is not enough, because ordinary prose starts with these words, and
 * one such sentence in one ticket refused every ticket in the effort.
 */
function declaresBlockers(line: string): boolean {
	const stripped = undecorate(line);
	if (!BLOCKER_NAME.test(stripped)) return false;
	return (
		// `Blocked_by: 2`, `Dependencies: 2` — a colon straight after the name.
		BLOCKER_FIELD.test(stripped) ||
		// `| Blocked by | 2 |` — a table row, where cells take the colon's place.
		line.startsWith("|") ||
		// `Blocked by the tickets listed below:` — a lead-in to a list. A sentence ends otherwise.
		(stripped.endsWith(":") && !SENTENCE_END.test(stripped)) ||
		// `Blocked by 2`, `Blocked by #2, #3` — the colon omitted, and `Blocked by` alone above a list.
		// Numbers and separators only: one word after the name and it is a sentence, so "blocked by 3
		// separate reviews" stays prose.
		BARE_NUMBERS.test(stripped.replace(BLOCKER_NAME, ""))
	);
}
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

	const identified = parsed.map((file) => ({ ...file, id: ticketId(file.ticket.ref) }));

	// Two things here deliberately report no openness and so read "unknown": a `Blocked by:` reference
	// to a number no file in this effort carries, and a ticket closed without its dependency being met.
	// Both degrade their dependents to unknown rather than to unblocked.
	const graph = seedGraph(
		identified.map(({ ticket, openness, id }) => ({
			id,
			// Markdown has no containment relation, so every ticket is a confirmed root rather than an
			// unread one.
			parent: null,
			blockers: ticket.blockers.map(ticketId),
			open: openness,
		})),
	);

	return {
		root: effortRoot,
		graph,
		tickets: identified.map(({ ticket, id }) => ({
			...ticket,
			blocked: deriveEffectiveBlockedness(id, graph),
		})),
	};
}

function readTicketFiles(issuesDir: string): ParsedFile[] {
	const parsed: ParsedFile[] = [];
	const seen = new Map<string, string>();

	for (const name of listDirectory(issuesDir).sort()) {
		// macOS writes .DS_Store into any directory the Finder has opened, unbidden.
		if (name.startsWith(".")) continue;
		const path = join(issuesDir, name);
		if (!isReadableFile(path)) continue;

		// A README or a template alongside the tickets is directory junk, skipped for the same reason a
		// dotfile and an unreadable entry are: refusing would take a whole effort down over one file,
		// which is the cost this module declines to pay for a blocking cycle a few lines below. It errs
		// toward a ticket being absent, never toward one being available when it is not.
		const named = TICKET_FILENAME.exec(name);
		if (named?.[1] === undefined) continue;
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
function onFilesystem<T>(path: string, verb: string, read: () => T): T {
	try {
		return read();
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new MarkdownEffortError(`${path} could not be ${verb}: ${detail}`);
	}
}

function listDirectory(dir: string): string[] {
	return onFilesystem(dir, "listed as a directory", () => readdirSync(dir));
}

/**
 * Whether this entry is a file worth parsing. A missing entry is skipped rather than refused — a
 * dangling symlink, or a file removed between the listing and this call, is directory junk, and a
 * ticket that vanishes is at worst a dangling blocker reference, which resolves as unknown. Any other
 * failure is refused, because it says the effort cannot be read rather than that an entry is absent.
 */
function isReadableFile(path: string): boolean {
	return onFilesystem(path, "inspected", () => statSync(path, { throwIfNoEntry: false })?.isFile() === true);
}

function readTicketText(path: string): string {
	return onFilesystem(path, "read", () => readFileSync(path, "utf8"));
}

/**
 * Drops the `<NN> —` prefix a title repeats from its filename, and refuses the two if they disagree.
 * The strip is justified only by the two numbers being the same fact, so a mismatch is evidence of a
 * rename or a copy-pasted title — and discarding it silently leaves a sibling's `Blocked by: 12`
 * pointing at a number no file carries, which degrades that dependent to unknown for no stated reason.
 */
function stripTitleNumber(title: string, key: string, path: string): string {
	const prefixed = TITLE_NUMBER_PREFIX.exec(title);
	if (prefixed?.[1] === undefined) return title;
	if (prefixed[1].replace(/^0+/, "") !== key) {
		throw new MarkdownEffortError(
			`${path} is numbered ${key} but its title is numbered ${prefixed[1]}; one of the two is wrong`,
		);
	}
	return title.replace(TITLE_NUMBER_PREFIX, "");
}

function parseTicketFile(text: string, path: string, number: string): ParsedFile {
	const { title: rawTitle, fields } = readHeader(text, path);
	if (rawTitle === null) {
		throw new MarkdownEffortError(`${path} has no H1 title`);
	}

	const status = readStatus(fields.get("status"), path);
	const ref = resolveMarkdownRef(
		number,
		() => `${path} is numbered ${number}, which is not a valid ticket number`,
	);
	const title = stripTitleNumber(rawTitle, ref.key, path);
	// A ticket blocking itself, and a cycle between several, are deliberately not refused here: the
	// shared traversal is built to terminate on them, so refusing them in one adapter would make
	// markdown disagree with the other three about which graphs are legal, and would take a whole
	// effort down over one file.
	//
	// The read is correct either way, but not uniformly `blocked`: a cycle whose members are all open
	// reads blocked throughout, while one containing a resolved member prunes at that edge and its
	// dependent reads unblocked — which is right, since a resolved blocker is a met dependency. What
	// is missing is only the diagnostic: nothing yet distinguishes a deadlocked effort from a backlog
	// that happens to be entirely blocked, and that needs the whole graph, so it belongs to the
	// selector rather than to one adapter's file parsing.
	const blockers = parseBlockers(fields.get("blocked by"), path);

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

/**
 * What counts as a markdown ticket number is `resolveTicketRef`'s to define, so both the filename and
 * the `Blocked by:` paths resolve through it rather than through a local copy of the rule. A number
 * it rejects — "0-a.md" — is still a malformed effort rather than a malformed reference, so the
 * refusal is translated to this module's error; the two call sites once translated it separately and
 * one of them was missed for a release.
 */
function resolveMarkdownRef(token: string, describeRefusal: () => string): TicketRef {
	try {
		return resolveTicketRef(`md:${token}`);
	} catch (cause) {
		if (!(cause instanceof TicketRefError)) throw cause;
		throw new MarkdownEffortError(describeRefusal());
	}
}

/**
 * The fields above the first section heading. Bold markers are stripped before matching, so the form
 * `to-tickets` emits and the plain form the wayfinder convention writes are one shape by the time it
 * is read: `**Status:** x`, `**Status**: x`, and `Status: x` all arrive here identically.
 *
 * Nothing else is a field. ADR-0008 has the reasoning; the short version is that this adapter reads
 * only files this project authors, so a decorated or indented field is a quotation rather than a
 * declaration, and treating it as one is how a quoted `Status: resolved` came to close a ticket.
 */
function readHeader(text: string, path: string): { title: string | null; fields: Map<string, string> } {
	const lines = markCodeRegions(text.split("\n"), path);
	const title = markHeaderBoundary(lines, path);
	return { title, fields: readFields(lines, path) };
}

/**
 * One source line, with the two questions that used to be answered mid-field-scan already settled.
 * Resolving them in order is the point: they were four regexes evaluated in a load-bearing sequence
 * inside the field loop, and three separate holes in that sequence each let body prose be read as a
 * real field — which prunes a live blocker and reports a confident `unblocked`.
 */
interface SourceLine {
	/** Bold markers removed and trimmed, which is what a field is matched against. */
	readonly text: string;
	/** The line as written, before bold markers are collapsed. */
	readonly raw: string;
	/** Markdown reads this as code: inside a fence, or in an indented block. Never a field. */
	readonly code: boolean;
	/** Indented far enough to be a code block on its own. */
	readonly indented: boolean;
	/** At or below the line that ended the header region. */
	body: boolean;
}

// A fence is a run of at least three backticks or tildes. CommonMark closes it only with the same
// character, which is why the opener is remembered rather than a boolean: a `~~~` inside a ``` block
// closed it early, and the fenced lines below were then read as this ticket's real fields.
const FENCE = /^(`{3,}|~{3,})/;

function markCodeRegions(rawLines: readonly string[], path: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let fence: string | null = null;

	for (const raw of rawLines) {
		const bare = raw.replace(/\*\*/g, "");
		// An indented fence is literal content of an indented code block, not a fence marker. Treating
		// it as one refused whole efforts whose notes showed fence syntax as an indented example.
		const indented = INDENTED_CODE.test(bare);
		const marker = indented ? null : FENCE.exec(raw.trim())?.[1];

		if (fence === null) {
			if (marker !== undefined && marker !== null) fence = marker;
			lines.push({ text: bare.trim(), raw, code: marker != null, indented, body: false });
			continue;
		}
		const closes = marker != null && marker[0] === fence[0] && marker.length >= fence.length;
		if (closes) fence = null;
		lines.push({ text: bare.trim(), raw, code: true, indented, body: false });
	}

	if (fence !== null) {
		throw new MarkdownEffortError(`${path} has an unterminated code fence, which hides any field below it`);
	}
	return lines;
}

// A thematic break, tested on the raw line: the bold-marker strip collapses `**` pairs, so `***`
// reached this as one stray `*` and never matched.
const THEMATIC_BREAK = /^(?:\*{3,}|_{3,}|-{3,})$/;
// A setext underline is one or more `=` or `-` under a paragraph line, per CommonMark. Requiring three
// left a one- or two-dash heading unrecognised, so everything under it stayed in the header region.
const SETEXT_UNDERLINE = /^(?:=+|-+)$/;

/**
 * Finds the title and marks where the header region ends. Returns the title so the caller need not
 * ask again — and the title is settled here, before any field is read, so a title that happens to
 * read "Blocked by 3 upstream changes" can never be mistaken for a malformed declaration.
 */
function markHeaderBoundary(lines: SourceLine[], path: string): string | null {
	let title: string | null = null;
	let body = false;

	for (const [index, line] of lines.entries()) {
		if (line.code) {
			line.body = body;
			continue;
		}
		const raw = line.raw.trim();
		const heading = line.indented ? null : TITLE_LINE.exec(line.text);

		if (!body && heading?.[1] !== undefined) {
			if (title !== null) {
				throw new MarkdownEffortError(`${path} has more than one H1 title`);
			}
			title = heading[1];
			line.body = false;
			continue;
		}

		const previous = lines[index - 1];
		const underlines =
			title !== null &&
			SETEXT_UNDERLINE.test(raw) &&
			previous !== undefined &&
			!previous.code &&
			previous.text !== "";
		if (SECTION_HEADING.test(line.text) || (title !== null && THEMATIC_BREAK.test(raw)) || underlines) {
			body = true;
		}
		line.body = body;
	}
	return title;
}

/**
 * Whether a blocker-named heading is declaring blockers or introducing a prose section. Only what
 * follows it can say: `## Blocked by` above `- 2` is a declaration whose payload this parser will not
 * read, while `## Dependencies` above a paragraph is a section, and refusing on the name alone took a
 * whole effort down over one heading.
 */
function headingDeclaresBlockers(lines: readonly SourceLine[], index: number): boolean {
	const heading = lines[index];
	if (heading === undefined) return false;
	const text = undecorate(heading.text);
	if (!BLOCKER_NAME.test(text)) return false;

	// `## Blocked by: 2` carries its numbers itself. The bare-name clause `declaresBlockers` uses is no
	// help here, because a heading being nothing but a name is what headings are.
	const rest = text.replace(BLOCKER_NAME, "").replace(/^\s*:/, "");
	if (rest.trim() !== "" && BARE_NUMBERS.test(rest)) return true;

	for (const line of lines.slice(index + 1)) {
		if (line.code || line.text === "") continue;
		if (HEADING.test(line.text)) return false;
		return BARE_NUMBERS.test(undecorate(line.text));
	}
	return false;
}

function readFields(lines: readonly SourceLine[], path: string): Map<string, string> {
	const fields = new Map<string, string>();

	for (const [index, line] of lines.entries()) {
		if (line.code) continue;

		if (HEADING.test(line.text)) {
			if (headingDeclaresBlockers(lines, index)) {
				throw new MarkdownEffortError(
					`${path} has a "${line.text}" section listing ticket numbers; write them as an unindented "Blocked by: <numbers>" line above the first section heading`,
				);
			}
			continue;
		}
		// A field is only a field in the accepted grammar: unindented, undecorated, plain or bold.
		const field = line.indented ? null : FIELD_LINE.exec(line.text);

		if (field?.[1] === undefined) {
			// Not a field, so the only question left is whether it names blockers in a shape that would
			// be dropped. Dropped reads as a confident `unblocked`, so it is refused instead.
			if (declaresBlockers(line.text)) {
				throw new MarkdownEffortError(
					`${path} names blockers in a shape this parser cannot read ("${line.text}"); write it as an unindented "Blocked by: <numbers>" line above the first section heading, or fence it if it is prose`,
				);
			}
			continue;
		}

		const key = field[1].toLowerCase();
		// An accepted-shape field below the boundary is refused rather than read or ignored. Ignoring it
		// is what let `Status: claimed` below a divider report somebody's in-flight work as available —
		// and `Blocked by:` in that same position was already refused, so silence here was an asymmetry
		// with nothing behind it.
		if (line.body) {
			throw new MarkdownEffortError(
				`${path} has a ${field[1]} field below a section heading, where it is not read as this ticket's own; move it above the first heading, or fence it if it is prose`,
			);
		}
		if (fields.has(key)) {
			throw new MarkdownEffortError(`${path} has more than one ${field[1]} field`);
		}
		fields.set(key, field[2] ?? "");
	}
	return fields;
}

function readStatus(value: string | undefined, path: string): StatusReading {
	// The wayfinder convention records only `claimed` and `resolved`, so an absent Status line is how
	// an open, unclaimed ticket is written — which is `open`'s own entry rather than a second literal
	// spelling out the same four fields, where a change to one would silently not reach the other.
	const absent = value === undefined || value === "";
	const known = STATUS_VOCABULARY.get(absent ? "open" : value.toLowerCase());
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
function opennessOf(status: StatusReading): boolean | "unknown" {
	if (status.state === "open") return true;
	return status.met ? false : "unknown";
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
		// `#6` is how the tickets this project writes name a blocker — issue 7's own body says
		// `**Blocked by:** #6` — so the prefix is accepted per ADR-0008's clause for a shape an authored
		// producer emits. Refusing it took the whole effort down and yielded no candidates at all.
		return resolveMarkdownRef(
			token.replace(/^#/, ""),
			() => `${path} has Blocked by listing "${token}", which is not a ticket number in this effort`,
		);
	});
}
