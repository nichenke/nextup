import { describe, expect, test } from "bun:test";
import { formatCommand } from "./command-builders";
import {
	type CommandTemplate,
	CommandTemplateError,
	REF_PLACEHOLDER,
	parseCommandTemplate,
	templatedCommand,
} from "./command-template";
import type { TicketRef } from "./ticket-ref";

const REF: TicketRef = { tracker: "github", repo: "example/repo", key: "1" };

function run(text: string, ref: TicketRef = REF): readonly string[] {
	return templatedCommand(parseCommandTemplate(text), ref);
}

function refusal(text: string): CommandTemplateError {
	try {
		parseCommandTemplate(text);
	} catch (cause) {
		if (cause instanceof CommandTemplateError) return cause;
		throw cause;
	}
	throw new Error(`expected ${JSON.stringify(text)} to be refused`);
}

describe("parseCommandTemplate", () => {
	test("the placeholder is {ref}", () => {
		expect(REF_PLACEHOLDER).toBe("{ref}");
	});

	test("splits on runs of whitespace, ignoring it at either end", () => {
		expect(run("  phase-worker   --ticket {ref}  ")).toEqual(["phase-worker", "--ticket", "gh:example/repo#1"]);
	});

	test("reads tabs, newlines and a no-break space as whitespace like spaces", () => {
		expect(run("phase-worker\t--ticket\n{ref}")).toEqual(["phase-worker", "--ticket", "gh:example/repo#1"]);
		expect(run("phase-worker {ref}")).toEqual(["phase-worker", "gh:example/repo#1"]);
	});

	test.each(["{ref}", "{ref} --verbose", "w{ref} x", "{ref}{ref} {ref}"])(
		"refuses %j, whose first word would make the ticket's reference the program",
		(text) => {
			expect(refusal(text).message).toContain("first word");
		},
	);

	test.each(["", "   ", "\t\n"])("refuses a blank template %j", (text) => {
		expect(refusal(text).message).toContain("blank");
	});

	test("accepts every character formatCommand leaves bare, and = in any word but the first", () => {
		expect(run("bin/w_2.sh --log=run-{ref}.log x,y:z@1 a%b+c {ref}")).toEqual([
			"bin/w_2.sh",
			"--log=run-gh:example/repo#1.log",
			"x,y:z@1",
			"a%b+c",
			"gh:example/repo#1",
		]);
	});

	test("accepts a word that is only placeholders, in any position after the first", () => {
		expect(run("w {ref}{ref} {ref}")).toEqual(["w", "gh:example/repo#1gh:example/repo#1", "gh:example/repo#1"]);
	});

	test.each([
		["a single quote", "sh -c 'x {ref}'", "'x"],
		["a double quote", 'w "{ref}"', '"{ref}"'],
		["a backslash", "w a\\ b {ref}", "a\\"],
		["a backslash in the placeholder's own word", "w \\{ref}", "\\{ref}"],
		["a quote in the program word", "'w' {ref}", "'w'"],
		["command substitution", "w $(x) {ref}", "$(x)"],
		["a variable", "w $HOME {ref}", "$HOME"],
		["a variable around the placeholder", "w ${ref}", "${ref}"],
		["a tilde in the program word", "~/bin/w {ref}", "~/bin/w"],
		["a tilde before the placeholder", "w ~/{ref}", "~/{ref}"],
		["an assignment in the program word", "FOO=1 w {ref}", "FOO=1"],
		["an assignment around a placeholder in the program word", "{ref}=1 w", "{ref}=1"],
		["a word zsh would expand as a command path", "w {ref} =ls", "=ls"],
		["a placeholder after a leading =", "w ={ref}", "={ref}"],
		["a program word bash and zsh would read as a job spec", "%w {ref}", "%w"],
		["a redirection", "w {ref} > log", ">"],
		["a redirection inside a word", "w {ref} 2>&1", "2>&1"],
		["a command separator", "w {ref}; x", "{ref};"],
		["a pipe", "w {ref} | tee", "|"],
		["a glob", "w * {ref}", "*"],
		["a single-character glob", "w ? {ref}", "?"],
		["a bracket glob", "w [ab] {ref}", "[ab]"],
		["a backtick", "w `id` {ref}", "`id`"],
		["a comment", "w {ref} #x", "#x"],
		["a background", "w {ref} &", "&"],
		["braces left over around a placeholder", "w {{ref}}", "{{ref}}"],
		["a letter outside ASCII", "w café {ref}", "café"],
	])("refuses %s, naming the word and saying the template is not shell", (_, text, word) => {
		const { message } = refusal(text);
		expect(message).toContain(`word ${word} `);
		expect(message).toContain("not shell");
	});

	test.each([
		["no placeholder at all", "phase-worker"],
		["a placeholder missing its brace", "phase-worker {ref"],
		["a placeholder in the wrong case", "phase-worker {REF}"],
		["a placeholder split across words", "phase-worker { ref }"],
	])("refuses %s, since the session would not know its ticket", (_, text) => {
		expect(refusal(text).message).toContain(REF_PLACEHOLDER);
	});

	test("refuses a word it would not pass as written before a template that also lacks the placeholder", () => {
		expect(refusal("sh -c 'x'").message).toContain("not shell");
	});
});

describe("templatedCommand", () => {
	test("substitutes the reference's short form at the placeholder", () => {
		expect(run("phase-worker {ref}")).toEqual(["phase-worker", "gh:example/repo#1"]);
	});

	test("substitutes inside a longer word", () => {
		expect(run("w --ticket={ref} --log=/tmp/{ref}.log")).toEqual([
			"w",
			"--ticket=gh:example/repo#1",
			"--log=/tmp/gh:example/repo#1.log",
		]);
	});

	test("substitutes every placeholder, across words and twice within one", () => {
		expect(run("w {ref} {ref}{ref}")).toEqual(["w", "gh:example/repo#1", "gh:example/repo#1gh:example/repo#1"]);
	});

	test("substitutes the short form of every tracker", () => {
		expect(run("w {ref}", { tracker: "gitlab", repo: "owner/sub/repo", host: null, key: "1" })).toEqual([
			"w",
			"glab:owner/sub/repo#1",
		]);
		expect(run("w {ref}", { tracker: "jira", host: null, key: "ABC-12" })).toEqual(["w", "jira:ABC-12"]);
	});

	test("inserts the reference verbatim, reading no replacement pattern out of it", () => {
		const ref: TicketRef = { tracker: "jira", host: null, key: "$&$1$$" };
		expect(run("w {ref}", ref)).toEqual(["w", "jira:$&$1$$"]);
	});

	test("leaves a template that has been used once ready to use again", () => {
		const template = parseCommandTemplate("w {ref}");
		templatedCommand(template, REF);
		expect(templatedCommand(template, { ...REF, key: "2" })).toEqual(["w", "gh:example/repo#2"]);
	});
});

describe("a templated command through formatCommand", () => {
	test("quotes the substituted reference, whose # a shell would otherwise read as a comment", () => {
		expect(formatCommand(run("phase-worker {ref}"))).toBe("phase-worker 'gh:example/repo#1'");
	});

	test("types every word without a placeholder exactly as the template wrote it", () => {
		const text = "bin/w --log=run-{ref}.log x,y:z@1 --ticket {ref}";
		expect(formatCommand(run(text))).toBe("bin/w '--log=run-gh:example/repo#1.log' x,y:z@1 --ticket 'gh:example/repo#1'");
	});

	test.each(["sh", "bash", "zsh"])("reaches %s as the very words the template and the reference make", (name) => {
		if (Bun.which(name) === null) return;
		const ref: TicketRef = { tracker: "jira", host: null, key: "it's $HOME =ls" };
		const words = run("w_1 --a=b,c:d@e%f+g ./x/{ref}.log {ref}", ref);
		const line = `f() { for word in "$@"; do printf '%s\\n' "$word"; done; }; f ${formatCommand(words)}`;
		const shell = Bun.spawnSync({ cmd: [name, "-c", line], stdout: "pipe", stderr: "pipe" });

		expect(shell.exitCode).toBe(0);
		expect(shell.stdout.toString().split("\n").slice(0, -1)).toEqual([...words]);
	});
});

describe("CommandTemplate", () => {
	test("refuses a template copied by spreading one that parsed, which keeps none of its words", () => {
		const forged = { ...parseCommandTemplate("w {ref}"), words: ["sh", "-c", "x"] } as unknown as CommandTemplate;
		expect(() => templatedCommand(forged, REF)).toThrow(TypeError);
	});

	test("refuses an object that only looks like a template", () => {
		const forged = { words: ["sh"] } as unknown as CommandTemplate;
		expect(() => templatedCommand(forged, REF)).toThrow(TypeError);
	});
});
