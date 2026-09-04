import { type TicketRef, formatTicketRef } from "./ticket-ref";

export class CommandBuilderError extends Error {}

/** The verb the launched session runs when nothing names another; ticket 09 exposes the choice. */
export const DEFAULT_SLASH_COMMAND = "/implement";

/**
 * The binary a session is started with. Not a parameter: which harness runs the work is a property of
 * this tool rather than of a ticket, and a flag for it would be a second way to say what the launcher
 * already is.
 */
const SESSION_BINARY = "claude";

export interface SessionCommandInput {
	readonly ref: TicketRef;
	readonly slashCommand: string;
}

/**
 * The argv that starts a session working on one ticket.
 *
 * The whole task is the reference, per ADR-0002's split: a briefing would carry the selector's own
 * reasoning into the new session and bias it toward whichever framing won the ranking, so the session
 * reads the ticket itself. Prompt and reference are one argument, because two would reach the session
 * as a slash command with no argument followed by a stray word.
 *
 * @throws CommandBuilderError when `slashCommand` is not a single `/`-prefixed word.
 */
export function sessionCommand(input: SessionCommandInput): readonly string[] {
	if (!/^\/\S+$/.test(input.slashCommand)) {
		throw new CommandBuilderError(`${input.slashCommand} is not a slash command: it must be "/" and one word`);
	}
	return [SESSION_BINARY, `${input.slashCommand} ${formatTicketRef(input.ref)}`];
}

/**
 * Argv as one line a POSIX shell parses back into the same words, for a human to read or paste. It is
 * never what the tool executes — the runner takes argv — so this cannot become the path by which a
 * quoting bug reaches a shell.
 */
export function formatCommand(argv: readonly string[]): string {
	return argv.map(quote).join(" ");
}

// Single quotes, which a POSIX shell leaves entirely literal, so only the closing quote itself needs
// handling. Deciding a word is safe by an allowlist rather than by escaping the characters that are
// not: an escape list has to stay complete as shells add syntax, and an allowlist that falls behind
// only over-quotes.
function quote(word: string): string {
	if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
