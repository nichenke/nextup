import { readFileSync } from "node:fs";
import { seedGraph } from "./graph-store";
import { type LabelFilterSpec, compileLabelFilter } from "./label-filter";
import { type SelectionInput } from "./selector";
import { type Claim, type Ticket, ticketId } from "./ticket";
import { type TicketRef, resolveTicketRef } from "./ticket-ref";

export class ScenarioError extends Error {}

/**
 * One golden-file scenario: a ticket set and the filter applied to it, as written on disk.
 */
export interface Scenario {
	readonly description: string;
	readonly input: SelectionInput;
}

/** Parses a scenario file, refusing an unrecognised key. README's "Fixing a bad pick" says why. */
export function loadScenario(path: string): Scenario {
	const raw = parseJson(path);
	const file = object(raw, path, "the scenario");
	keys(file, ["description", "truncated", "filter", "tickets"], path, "the scenario");

	const specs = array(file.tickets, path, "tickets").map((entry, index) =>
		readTicket(entry, path, `tickets[${index}]`),
	);
	const graph = seedGraph(
		specs.map((spec) => ({
			id: ticketId(spec.ticket.ref),
			// Markdown has no containment relation and no other tracker's is modelled here, so every
			// ticket is a confirmed root rather than an unread one.
			parent: null,
			blockers: spec.ticket.blockers === "unknown" ? ("unknown" as const) : spec.ticket.blockers.map(ticketId),
			open: spec.openness,
		})),
	);

	return {
		description: string(file.description, path, "description"),
		input: {
			tickets: specs.map((spec) => spec.ticket),
			graph,
			filter: compileLabelFilter(readFilter(file.filter, path)),
			truncated: boolean(file.truncated, path, "truncated"),
		},
	};
}

interface TicketSpec {
	readonly ticket: Ticket;
	/** Openness as a *blocker*: `"unknown"` where closing did not tell a dependent its wait was over. */
	readonly openness: boolean | "unknown";
}

function readTicket(raw: unknown, path: string, where: string): TicketSpec {
	const entry = object(raw, path, where);
	keys(entry, ["ref", "title", "state", "claim", "blockers", "labels", "url", "openness"], path, where);

	const state = literal(entry.state, ["open", "closed"], path, `${where}.state`);
	const ticket: Ticket = {
		ref: readRef(entry.ref, path, `${where}.ref`),
		title: string(entry.title, path, `${where}.title`),
		state,
		claim: readClaim(entry.claim, path, `${where}.claim`),
		blockers:
			entry.blockers === "unknown"
				? "unknown"
				: array(entry.blockers, path, `${where}.blockers`).map((blocker, index) =>
						readRef(blocker, path, `${where}.blockers[${index}]`),
					),
		url: entry.url === undefined || entry.url === null ? null : string(entry.url, path, `${where}.url`),
		labels:
			entry.labels === undefined
				? []
				: array(entry.labels, path, `${where}.labels`).map((label, index) =>
						string(label, path, `${where}.labels[${index}]`),
					),
	};

	const openness =
		entry.openness === undefined
			? state === "open"
			: entry.openness === "unknown"
				? ("unknown" as const)
				: boolean(entry.openness, path, `${where}.openness`);

	return { ticket, openness };
}

/**
 * Refuses every external command, so a reference that would resolve its repository from the working
 * directory's git remote fails here instead. A scenario has to name what it means: one that read the
 * surrounding checkout would assert a different thing in a different clone.
 */
const NO_RUNNER = () => ({ code: 127, stdout: "", stderr: "a scenario reference must name its own repository" });

function readRef(raw: unknown, path: string, where: string): TicketRef {
	const short = string(raw, path, where);
	try {
		return resolveTicketRef(short, { runner: NO_RUNNER });
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new ScenarioError(`${path}: ${where} is not a ticket reference: ${detail}`);
	}
}

function readClaim(raw: unknown, path: string, where: string): Claim | null {
	if (raw === undefined || raw === null) return null;
	const claim = object(raw, path, where);
	keys(claim, ["by"], path, where);
	return { by: claim.by === undefined || claim.by === null ? null : string(claim.by, path, `${where}.by`) };
}

function readFilter(raw: unknown, path: string): LabelFilterSpec {
	if (raw === undefined) return { include: [], exclude: [] };
	const filter = object(raw, path, "filter");
	keys(filter, ["include", "exclude"], path, "filter");
	return { include: patterns(filter.include, path, "filter.include"), exclude: patterns(filter.exclude, path, "filter.exclude") };
}

function patterns(raw: unknown, path: string, where: string): string[] {
	if (raw === undefined) return [];
	return array(raw, path, where).map((pattern, index) => string(pattern, path, `${where}[${index}]`));
}

function parseJson(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		throw new ScenarioError(`${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new ScenarioError(`${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

function object(raw: unknown, path: string, where: string): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ScenarioError(`${path}: ${where} must be an object`);
	}
	return raw as Record<string, unknown>;
}

function array(raw: unknown, path: string, where: string): unknown[] {
	if (!Array.isArray(raw)) throw new ScenarioError(`${path}: ${where} must be an array`);
	return raw;
}

function string(raw: unknown, path: string, where: string): string {
	if (typeof raw !== "string") throw new ScenarioError(`${path}: ${where} must be a string`);
	return raw;
}

function boolean(raw: unknown, path: string, where: string): boolean {
	if (typeof raw !== "boolean") throw new ScenarioError(`${path}: ${where} must be true or false`);
	return raw;
}

function literal<T extends string>(raw: unknown, allowed: readonly T[], path: string, where: string): T {
	const value = string(raw, path, where);
	if (!allowed.includes(value as T)) {
		throw new ScenarioError(`${path}: ${where} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

function keys(entry: Record<string, unknown>, allowed: readonly string[], path: string, where: string): void {
	for (const key of Object.keys(entry)) {
		if (!allowed.includes(key)) {
			throw new ScenarioError(`${path}: ${where} has an unrecognised key ${key} (expected ${allowed.join(", ")})`);
		}
	}
}
