import { formatCommand } from "./command-builders";
import type { Runner } from "./runner";

export class NotAReadError extends Error {}

/**
 * The commands the live check is allowed to issue, as the leading words each begins with. An allowlist rather
 * than a list of the writes to refuse: `gh` grows subcommands, so a denylist admits every write nobody thought
 * of, while an allowlist that falls behind only refuses a read somebody has to add here deliberately.
 */
const READS: readonly (readonly string[])[] = [
	["gh", "issue", "list"],
	["gh", "api"],
	// `readGitHubTicketSet` resolves the repository from the remote when none is named.
	["git", "remote", "get-url"],
];

/**
 * The `gh api` flags that turn a request into a write. `gh api` is GET until one of these appears — `--method`
 * says so outright, and the field and input flags each imply POST — so refusing all of them is what makes one
 * allowlist entry cover the whole endpoint space rather than every path under it.
 *
 * Refused whatever `--method` names, including `GET`: the check never needs to spell the default, so the
 * narrower rule buys nothing and costs a comparison that has to stay right.
 */
const WRITING_API_FLAGS: readonly string[] = ["-X", "--method", "-f", "--field", "-F", "--raw-field", "--input"];

/**
 * Wraps a runner so that only reads reach it, which is how issue 26's "writes nothing to any tracker" is a
 * property of the harness rather than a promise about it. A refusal throws rather than returning a failed
 * result: a write attempted here is a defect in the check, not something the tracker said no to.
 *
 * @throws NotAReadError before the command runs, when it is not one of `READS` or is a `gh api` write.
 */
export function readOnlyRunner(runner: Runner): Runner {
	return (argv) => {
		const program = argv[0]?.split("/").at(-1);
		const words = [program, ...argv.slice(1)];
		const read = READS.find((prefix) => prefix.every((word, index) => words[index] === word));
		if (read === undefined) {
			throw new NotAReadError(`${formatCommand(argv)} is not one of the reads this check may issue`);
		}
		const writing = read[1] === "api" ? argv.find((word) => isWritingApiFlag(word)) : undefined;
		if (writing !== undefined) {
			throw new NotAReadError(`${formatCommand(argv)} carries ${writing}, which makes it a write rather than a read`);
		}
		return runner(argv);
	};
}

/** Both spellings of a flag: on its own, and with its value attached after `=`. */
function isWritingApiFlag(word: string): boolean {
	return WRITING_API_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));
}
