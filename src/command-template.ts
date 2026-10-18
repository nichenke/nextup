import type { Argv } from "./command-builders";
import { type TicketRef, formatTicketRef } from "./ticket-ref";

/** The word, or part of a word, that a template's ticket reference is substituted into. */
export const REF_PLACEHOLDER = "{ref}";

export class CommandTemplateError extends Error {}

let construct: (words: Argv) => CommandTemplate;
let wordsOf: (template: CommandTemplate) => Argv;

/**
 * A session command with a place for the ticket reference, already refused every shape `parseCommandTemplate`
 * refuses, and buildable nowhere else.
 */
export class CommandTemplate {
	static {
		construct = (words) => new CommandTemplate(words);
		wordsOf = (template) => template.#words;
	}

	readonly #words: Argv;

	private constructor(words: Argv) {
		this.#words = words;
	}
}

/**
 * The template `text` spells, or a refusal.
 *
 * Split on runs of whitespace, and nothing more: the words are argv, and each is quoted by `formatCommand` on its
 * way to the workspace host's shell. Shell syntax in a word therefore reaches the program as literal text, which is
 * the point for `$` and `;` and the reason for the quoting refusal below. ADR-0044 has why a template is argv
 * rather than a shell line.
 *
 * @throws CommandTemplateError when `text` is blank; when a word contains `'`, `"` or `\`, which `formatCommand`
 * would quote along with the rest of the word, so that the program receives the quoting itself; and when no word
 * contains `REF_PLACEHOLDER`, because the reference is the session's whole task.
 */
export function parseCommandTemplate(text: string): CommandTemplate {
	const trimmed = text.trim();
	if (trimmed === "") throw new CommandTemplateError("the command template is blank, so there is nothing to run");
	const [first, ...rest] = trimmed.split(/\s+/);
	const words: Argv = [first!, ...rest];
	const quoted = words.find((word) => /['"\\]/.test(word));
	if (quoted !== undefined) {
		throw new CommandTemplateError(
			`the command template word ${quoted} contains a quote or a backslash, which would reach the program as a literal character because each word is passed exactly as written, so leave the quoting out`,
		);
	}
	if (!words.some((word) => word.includes(REF_PLACEHOLDER))) {
		throw new CommandTemplateError(
			`the command template ${trimmed} has no ${REF_PLACEHOLDER}, so the session would not be told which ticket it is for`,
		);
	}
	return construct(words);
}

/**
 * The argv that starts a session on `ref`: the template's words with every `REF_PLACEHOLDER`, including one inside
 * a longer word, replaced by the reference's short form. The reference is inserted verbatim and never rescanned.
 */
export function templatedCommand(template: CommandTemplate, ref: TicketRef): Argv {
	const formatted = formatTicketRef(ref);
	// `split` and `join` rather than `replaceAll` with a string, which reads `$&` and its kin in the replacement.
	const [first, ...rest] = wordsOf(template).map((word) => word.split(REF_PLACEHOLDER).join(formatted));
	return [first!, ...rest];
}
