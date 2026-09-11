import { formatCommand } from "./command-builders";
import type { Runner } from "./runner";

export class NotAReadError extends Error {}

/** The commands a reconstruction may issue, as leading words. An allowlist because `gh` grows subcommands; ADR-0033. */
const READS: readonly (readonly string[])[] = [
	["gh", "issue", "list"],
	// The single-ticket read the override path uses, which `readNamed` issues — a read like the list above, and
	// named as its own prefix because `gh issue` also holds `edit`, `close` and `comment`.
	["gh", "issue", "view"],
	["gh", "api"],
	// `reconstruct.ts` resolves the repository from the remote when `--repo` is absent. `--get-all` is part of the
	// prefix rather than trailing detail: it is what puts `git config` in a mode that cannot write, so without it
	// the same entry would admit `git config --local <key> <value>`.
	["git", "config", "--local", "--get-all"],
];

/**
 * The only flags a `gh api` call here may carry. Everything else beginning with `-` is refused, which is what
 * lets one `READS` entry stand for the whole endpoint space instead of a path list: `gh api` is a GET until a
 * flag makes it something else, so admitting two known-inert flags is a smaller thing to get right than
 * enumerating the ones that write.
 *
 * `-XPOST`, `-fkey=value` and `-iXPOST` all parse, measured on gh 2.100.0 — ADR-0033 has why that means naming
 * the writing flags cannot work.
 */
const READABLE_API_FLAGS: ReadonlySet<string> = new Set(["--paginate", "--slurp"]);

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
		// `git -C <directory>` is skipped before the prefix is matched, so a directory nobody can enumerate does
		// not sit between the program and the subcommand that decides whether this is a read. Skipping it admits
		// nothing: what follows is matched exactly as it would be without one.
		const rest = program === "git" && argv[1] === "-C" ? argv.slice(3) : argv.slice(1);
		const words = [program, ...rest];
		const read = READS.find((prefix) => prefix.every((word, index) => words[index] === word));
		if (read === undefined) {
			throw new NotAReadError(`${formatCommand(argv)} is not one of the reads this check may issue`);
		}
		const unknown = read[1] === "api" ? argv.slice(2).find((word) => word.startsWith("-") && !READABLE_API_FLAGS.has(word)) : undefined;
		if (unknown !== undefined) {
			throw new NotAReadError(`${formatCommand(argv)} carries ${unknown}, which is not a flag a read here may pass`);
		}
		return runner(argv);
	};
}
