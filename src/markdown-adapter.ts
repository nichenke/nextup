import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Token, type Tokens, marked } from "marked";
import { type BlockedState, type DependencyGraph, deriveEffectiveBlockedness } from "./effective-blockedness";
import { seedGraph } from "./graph-store";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, TicketRefError, resolveTicketRef } from "./ticket-ref";

export class MarkdownEffortError extends Error {}

/**
 * A markdown ticket, plus what only the file it came from can say. `blockers` narrows `Ticket`'s
 * tri-state to a list because a file either declares its blockers in the grammar or does not: there is
 * no read this adapter can attempt and fail at, so it is never uncertain. Per ADR-0010 it also does not
 * infer blockers from anything outside the grammar, which is a residue that ADR records rather than a
 * claim to have read everything.
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
// The number already comes from the filename, so a title repeating it is a duplicate rather than part
// of the title. Only the em dash form the local ticket template writes — `# <NN> — <Title>`. Accepting
// an en dash or hyphen too was invented tolerance, and the hyphen form then needed its own guard against
// eating the first word of a title that legitimately starts with a number ("3-way merge conflict
// resolution"). Requiring the spacing the template uses removes both the variants and the guard.
const TITLE_NUMBER_PREFIX = /^(\d+)\s+—\s+/;
// The whole accepted field grammar, per ADR-0008: a `Name: value` line, plain or bold, inside a
// paragraph of the header region. Deliberately narrow — the only producers writing these files are the
// wayfinder local-markdown convention and the `to-tickets` skill.
const FIELD_LINE = /^(Type|Status|Blocked by)\s*:\s*(.*?)\s*$/i;
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
 *
 * The entry types matter, not just existence: a `map.md` that is a directory passed an existence check
 * and then read as a valid effort holding no tickets, which a caller cannot tell apart from a real
 * effort with nothing takeable.
 */
function isEffortRoot(root: string): boolean {
	return entryIs(join(root, MAP_FILE), "file") && entryIs(join(root, ISSUES_DIR), "directory");
}

/**
 * Whether an entry exists and is of that kind. Any failure to find out answers "no" — the whole errno
 * class that `onFilesystem` below enumerates, rather than the one instance of it that a junk entry in
 * `.scratch` happened to raise while aborting discovery for every effort.
 *
 * Deliberately more forgiving than `isReadableFile`, which is inside an effort we have already committed
 * to reading and where an unreadable ticket file is a real failure. Here the question is only whether a
 * candidate is an effort at all, and "cannot tell" and "no" have the same consequence.
 */
function entryIs(path: string, kind: "file" | "directory"): boolean {
	try {
		const entry = statSync(path, { throwIfNoEntry: false });
		if (entry === undefined) return false;
		return kind === "file" ? entry.isFile() : entry.isDirectory();
	} catch {
		return false;
	}
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

		// A README or a template alongside the tickets is directory junk, skipped for the same reason a
		// dotfile and an unreadable entry are: refusing would take a whole effort down over one file,
		// which is the cost this module declines to pay for a blocking cycle a few lines below. It errs
		// toward a ticket being absent, never toward one being available when it is not.
		//
		// Checked before the entry is inspected, so only real ticket names cost a syscall.
		const named = TICKET_FILENAME.exec(name);
		if (named?.[1] === undefined) continue;
		const path = join(issuesDir, name);
		if (!isReadableFile(path)) continue;
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
	// Cut what the match already measured, rather than running the pattern a second time where the two
	// runs could come to disagree about what the prefix was.
	return title.slice(prefixed[0].length);
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
 * The fields in the header region: the run of paragraphs after the H1, up to the first block that is
 * anything else. Block and inline structure both come from a CommonMark lexer rather than from patterns
 * here — ADR-0009 records why, and ADR-0008 records what the accepted grammar is.
 *
 * Nothing outside that region is looked at. This adapter reads the one existing pack of `.scratch`
 * tickets and whatever this project writes itself, so it reads the grammar and does not try to infer
 * what an out-of-grammar line meant. ADR-0010 has the reasoning; the short version is that guessing an
 * author's intent has no specification to defer to, and every round of trying produced either a
 * silently dropped blocker or an effort refused over a sentence.
 */
function readHeader(text: string, path: string): { title: string | null; fields: Map<string, string> } {
	const fields = new Map<string, string>();
	let title: string | null = null;

	for (const token of marked.lexer(text)) {
		if (token.type === "space") continue;
		if (token.type === "heading") {
			// The first heading is the title, and any heading after it ends the header region whatever its
			// depth — depth cannot be that test, because a setext `===` underline makes a level-one
			// heading. The title itself must be level one, or a leading `## Notes` became the title and
			// that section's body was read as this ticket's metadata.
			if (title !== null || (token as Tokens.Heading).depth > 1) break;
			title = renderedText((token as Tokens.Heading).tokens);
			continue;
		}
		// Only paragraphs *under* the title are the header region. Reading one above it made a preamble
		// line authoritative metadata for a ticket whose title had not been seen yet.
		if (token.type === "paragraph") {
			if (title !== null) addFields(blockLines(token), fields, path);
			continue;
		}
		// A code block does not end the region: `to-tickets` inlines a snippet where one encodes a
		// decision more precisely than prose, and fields written after it are still the ticket's own.
		if (token.type === "code") continue;
		// Nothing above the title can be a boundary, because there is no region to end yet — breaking
		// here reported "no H1 title" for a file with a leading comment or divider.
		if (title === null) continue;
		break;
	}
	return { title, fields };
}

function addFields(lines: readonly BlockLine[], fields: Map<string, string>, path: string): void {
	// A paragraph holds every field written on consecutive lines, since a soft break does not start a
	// new block — which is exactly how the wayfinder convention writes Type, Status and Blocked by. A
	// line that is not a field is prose, and is left alone.
	for (const line of lines) {
		if (!line.plain) continue;
		const field = FIELD_LINE.exec(line.text.trim());
		if (field?.[1] === undefined) continue;
		const key = field[1].toLowerCase();
		if (fields.has(key)) {
			throw new MarkdownEffortError(`${path} has more than one ${field[1]} field`);
		}
		// A field with nothing after the colon is malformed, not absent. Reading the two the same way is
		// how an empty `Status:` came to mean open and unclaimed, which can hand out a ticket the file was
		// trying to mark claimed. Absence is the convention for open and unclaimed; blankness is a typo.
		const value = field[2] ?? "";
		if (value === "") {
			throw new MarkdownEffortError(`${path} has an empty ${field[1]} field; give it a value or remove the line`);
		}
		fields.set(key, value);
	}
}

/**
 * One line of a block: its text, and whether every inline token that contributed to it was one a field
 * may be written with — plain text or bold. A line only some other inline form touched is prose.
 *
 * Tracked per line rather than reconstructed from source, because an inline span can cross a line break:
 * an emphasis opened on one line and closed on the next put a stray marker on the second, which then
 * matched the grammar with a garbage value and refused the whole effort. Whether a token spans a break is
 * something only the walk knows, and nothing a rendered string retains.
 */
interface BlockLine {
	readonly text: string;
	readonly plain: boolean;
}

function blockLines(token: Token): BlockLine[] {
	const inline = (token as { tokens?: Token[] }).tokens;
	if (inline === undefined || inline.length === 0) {
		const raw = "text" in token && typeof token.text === "string" ? token.text.split("\n") : [];
		return raw.map((line) => ({ text: line, plain: true }));
	}
	const lines: Array<{ text: string; plain: boolean }> = [{ text: "", plain: true }];
	appendInline(inline, lines);
	return lines;
}

/**
 * Walks inline tokens onto lines, marking a line impure the moment a form other than plain text or bold
 * touches it. That is the field grammar's inline half, which ADR-0008 states.
 *
 * Bold is whatever the lexer calls `strong`, which is wider than the `**Status:**` the producers write —
 * `__Status__:` is accepted too. Narrowing that would mean inspecting marker characters, the enumeration
 * ADR-0009 moved to the lexer to escape, so the rule is stated as what the code does rather than as
 * something stricter.
 */
function appendInline(tokens: readonly Token[], lines: Array<{ text: string; plain: boolean }>): void {
	const last = (): { text: string; plain: boolean } => lines[lines.length - 1]!;
	for (const token of tokens) {
		if (token.type === "br") {
			lines.push({ text: "", plain: true });
			continue;
		}
		const nested = (token as { tokens?: Token[] }).tokens;
		if (token.type === "text" || token.type === "strong") {
			if (nested !== undefined && nested.length > 0) {
				appendInline(nested, lines);
				continue;
			}
			const text = "text" in token && typeof token.text === "string" ? token.text : "";
			const parts = text.split("\n");
			last().text += parts[0] ?? "";
			for (const part of parts.slice(1)) lines.push({ text: part, plain: true });
			continue;
		}
		// The rendered text still belongs to the line — a value may legitimately contain one — but every
		// line this form touches stops being a candidate field.
		const rendered = nested !== undefined && nested.length > 0 ? renderedText(nested) : renderedText([token]);
		const parts = rendered.split("\n");
		last().text += parts[0] ?? "";
		last().plain = false;
		for (const part of parts.slice(1)) lines.push({ text: part, plain: false });
	}
}

/**
 * Inline tokens flattened to the text a reader sees, with emphasis, code spans and link syntax removed
 * by the lexer. Used for a ticket's title, which is descriptive, and for the text a non-plain inline form
 * contributes to a line — never to decide whether a line is a field. That decision is `appendInline`'s,
 * and it turns on which forms touched the line rather than on what they rendered to.
 */
function renderedText(tokens: readonly Token[]): string {
	return tokens
		.map((token) => {
			// A hard break is a line break with no text of its own, so rendering it as nothing joined two
			// field lines into one — and a real blocker vanished into the value above it, invisibly, since
			// the two trailing spaces that make a hard break cannot be seen in the source.
			if (token.type === "br") return "\n";
			const nested = (token as { tokens?: Token[] }).tokens;
			if (nested !== undefined && nested.length > 0) return renderedText(nested);
			return "text" in token && typeof token.text === "string" ? token.text : "";
		})
		.join("");
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
	// Do not filter empty entries to be kind about a trailing comma: that is what let `Blocked by: ,`
	// reduce to a confirmed empty list. A tracker returns references or no field at all, with no notion
	// of an entry that is present and blank.
	return value.split(",").map((entry) => {
		const token = entry.trim();
		// No `#` prefix: that is GitHub's rendering syntax, and a tracker's API hands back a dependency
		// object rather than the text a reader sees. The local ticket template writes bare numbers, so a
		// `#` here fails loudly rather than being quietly stripped.
		return resolveMarkdownRef(
			token,
			() => `${path} has Blocked by listing "${token}", which is not a ticket number in this effort`,
		);
	});
}
