import { type Argv, isBareWord } from "./command-builders";
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
 * Split on runs of whitespace and nothing more, because the words are argv, each passed through `formatCommand` on
 * its way to the workspace host's shell. ADR-0044 has why a template is argv rather than a shell line.
 *
 * @throws CommandTemplateError when `text` is blank; when a word without its placeholders is not one
 * `isBareWord` accepts in that position, since `formatCommand` would quote it and the program would receive
 * something other than what was written; when the first word contains `REF_PLACEHOLDER`, which would make the
 * ticket's reference the program; and when no word contains it, because the reference is the session's whole
 * task.
 */
export function parseCommandTemplate(text: string): CommandTemplate {
	const trimmed = text.trim();
	if (trimmed === "") throw new CommandTemplateError("the command template is blank, so there is nothing to run");
	const [first, ...rest] = trimmed.split(/\s+/);
	const words: Argv = [first!, ...rest];
	const unwritten = words.find((word, index) => {
		const written = word.split(REF_PLACEHOLDER).join("");
		return written !== "" && !isBareWord(written, index === 0);
	});
	if (unwritten !== undefined) {
		throw new CommandTemplateError(
			`the command template word ${unwritten} would not reach the program as written, because the template is not shell. Run nextup --help for the characters a word may hold besides ${REF_PLACEHOLDER}, and put anything needing a shell in a script the template runs`,
		);
	}
	if (first!.includes(REF_PLACEHOLDER)) {
		throw new CommandTemplateError(
			`the command template's first word ${first} is the program to run, so it cannot hold ${REF_PLACEHOLDER}; put the reference in a later word`,
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
