import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MarkdownEffortError,
	discoverEfforts,
	readEffort,
	readTicketFile,
	withStatus,
	type MarkdownTicket,
} from "./markdown-adapter";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every test drives real files in a temp directory, never a filesystem stub. */
function tempRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "nextup-md-"));
	roots.push(root);
	return root;
}

function writeEffort(repoRoot: string, effort: string, files: Record<string, string>): string {
	const effortRoot = join(repoRoot, ".scratch", effort);
	mkdirSync(join(effortRoot, "issues"), { recursive: true });
	writeFileSync(join(effortRoot, "map.md"), "## Destination\n\nSomewhere.\n");
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(effortRoot, "issues", name), body);
	}
	return effortRoot;
}

function byKey(tickets: readonly MarkdownTicket[]): Map<string, MarkdownTicket> {
	return new Map(tickets.map((ticket) => [ticket.ref.key, ticket]));
}

/** One ticket file, so a single-ticket assertion needs no second file to be valid. */
function oneTicket(repoRoot: string, name: string, body: string): MarkdownTicket {
	const effortRoot = writeEffort(repoRoot, "effort", { [name]: body });
	const tickets = readEffort(effortRoot).tickets;
	expect(tickets).toHaveLength(1);
	return tickets[0]!;
}

describe("discoverEfforts", () => {
	test("finds an effort directory holding both a map file and an issues directory", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "some-effort", { "01-first.md": "# 01 — First\n" });
		expect(discoverEfforts(repo)).toEqual([effort]);
	});

	test("returns efforts in a stable order rather than the filesystem's", () => {
		const repo = tempRepo();
		writeEffort(repo, "zebra", { "01-a.md": "# 01 — A\n" });
		writeEffort(repo, "aardvark", { "01-a.md": "# 01 — A\n" });
		expect(discoverEfforts(repo).map((path) => path.split("/").pop())).toEqual([
			"aardvark",
			"zebra",
		]);
	});

	test("skips a directory with an issues directory but no map file", () => {
		const repo = tempRepo();
		mkdirSync(join(repo, ".scratch", "no-map", "issues"), { recursive: true });
		expect(discoverEfforts(repo)).toEqual([]);
	});

	test("skips a directory with a map file but no issues directory", () => {
		const repo = tempRepo();
		mkdirSync(join(repo, ".scratch", "no-issues"), { recursive: true });
		writeFileSync(join(repo, ".scratch", "no-issues", "map.md"), "## Destination\n");
		expect(discoverEfforts(repo)).toEqual([]);
	});

	// One junk entry used to abort discovery for every effort; see `entryIs` for which errnos and why.
	test("junk beside the efforts does not abort discovery, whatever the entry is", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "real", { "01-a.md": "# 01 — A\n\nStatus: open\n" });
		writeFileSync(join(repo, ".scratch", "README.md"), "notes about these efforts\n");
		symlinkSync(join(repo, ".scratch", "loop"), join(repo, ".scratch", "loop"));
		expect(discoverEfforts(repo)).toEqual([effort]);
	});

	test("returns nothing when the repo has no scratch directory at all", () => {
		expect(discoverEfforts(tempRepo())).toEqual([]);
	});

	// Existence is not enough: a `map.md` that is a directory passed discovery and then read as a valid
	// effort with no tickets, which is indistinguishable from a real effort with nothing takeable.
	test("skips a directory whose map file is not a file, or whose issues is not a directory", () => {
		const repo = tempRepo();
		mkdirSync(join(repo, ".scratch", "map-is-a-dir", "issues"), { recursive: true });
		mkdirSync(join(repo, ".scratch", "map-is-a-dir", "map.md"), { recursive: true });
		mkdirSync(join(repo, ".scratch", "issues-is-a-file"), { recursive: true });
		writeFileSync(join(repo, ".scratch", "issues-is-a-file", "map.md"), "## Destination\n");
		writeFileSync(join(repo, ".scratch", "issues-is-a-file", "issues"), "not a directory\n");
		expect(discoverEfforts(repo)).toEqual([]);
	});
});

describe("readEffort: the observed plain-field format", () => {
	test("parses an H1 title, Type, Status, and Blocked by", () => {
		const ticket = oneTicket(
			tempRepo(),
			"02-pick-a-substrate.md",
			[
				"# 02 — Pick a substrate",
				"",
				"Type: grilling",
				"Status: open",
				"Blocked by: 1",
				"",
				"## Question",
				"",
				"Which one?",
				"",
				"## Notes",
				"",
				"Consult the glossary.",
			].join("\n"),
		);
		expect(ticket.ref).toEqual({ tracker: "markdown", repo: null, host: null, key: "2" });
		expect(ticket.title).toBe("Pick a substrate");
		expect(ticket.type).toBe("grilling");
		expect(ticket.state).toBe("open");
		expect(ticket.claim).toBeNull();
		expect(ticket.blockers).toEqual([
			{ tracker: "markdown", repo: null, host: null, key: "1" },
		]);
		expect(ticket.path).toEndWith("/issues/02-pick-a-substrate.md");
	});

	test("takes the ticket number from the filename and strips the title's copy of it", () => {
		const ticket = oneTicket(tempRepo(), "07-seventh.md", "# 07 — Seventh\n");
		expect(ticket.ref.key).toBe("7");
		expect(ticket.title).toBe("Seventh");
	});

	// The strip is only justified by the two numbers being one fact. Discarding a mismatch silently
	// leaves a sibling's `Blocked by: 42` pointing at a number no file carries, degrading it to
	// unknown for a reason nothing explains.
	test("a title numbered differently from its filename is refused, not silently discarded", () => {
		const effort = writeEffort(tempRepo(), "effort", { "07-seventh.md": "# 42 — Seventh\n" });
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		expect(() => readEffort(effort)).toThrow(/numbered/);
	});

	test("keeps a title that carries no number prefix intact", () => {
		const ticket = oneTicket(tempRepo(), "01-plain.md", "# Just a title\n");
		expect(ticket.title).toBe("Just a title");
	});

	// An absent field states no blockers; a present but empty one states nothing, and is how a
	// declaration whose numbers sit on following lines presents — the payload having been dropped.
	test("a Blocked by field present but empty is refused, unlike an absent one", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\nBlocked by:\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("blockers listed on the lines below a Blocked by field are not read as no blockers", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\nBlocked by:\n- 2\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("a ticket with no Blocked by field at all is unblocked", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: open\n");
		expect(ticket.blockers).toEqual([]);
		expect(ticket.blocked).toBe("unblocked");
	});

	// A `Status:` outside the header region is body text, not the ticket's own. One boundary is enough:
	// which lines end a section is CommonMark's answer, given by the lexer, not a spelling this suite
	// needs to enumerate.
	test("a Status below a section boundary is body text, not the ticket's state", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\n## Notes\n\nStatus: resolved\n");
		expect(ticket.state).toBe("open");
	});

	// Prose below the boundary is untouched unless it is field-shaped; the escape for quoting a field
	// verbatim is to fence it, which is what the refusal message tells an author to do.
	test("a fenced field below the boundary is a quotation, not a field", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			"# 01 — A\n\nStatus: open\n\n## Answer\n\n```\nStatus: resolved\n```\n",
		);
		expect(ticket.state).toBe("open");
	});

	test("an Answer section does not stop the file from parsing", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-done.md",
			"# 01 — Done\n\nType: research\nStatus: resolved\n\n## Answer\n\nIt was fine.\n",
		);
		expect(ticket.state).toBe("closed");
	});
});

describe("readEffort: the bold-field format the to-tickets skill emits", () => {
	// The lexer hands back inline text with every decoration already removed, so the grammar is about
	// rendered text rather than about which markers were used. Stripping `**` by hand instead left
	// `_Blocked by_: 2` matching nothing, so it was neither read nor refused.
	// Two trailing spaces are a hard line break, which the lexer reports as its own inline token. Losing
	// it joined two field lines into one, so a real blocker disappeared into the value above it — and
	// the source looks identical to the soft-break form, because trailing whitespace is invisible.
	// Nothing above the title can be a boundary, because there is no header region to end yet. YAML
	// front matter is deliberately not in this list: CommonMark reads `key: value` under `---` as a
	// setext heading, which is what it is, so no lexer can tell the two apart — and neither producer
	// writes front matter, so it stays out of grammar rather than being special-cased.
	test("a leading comment or divider above the title does not lose the file", () => {
		const repo = tempRepo();
		const ticket = oneTicket(repo, "02-b.md", "<!-- generated -->\n\n# 02 — B\n\nStatus: resolved\n");
		expect(ticket.title).toBe("B");
		expect(ticket.state).toBe("closed");
	});

	// A tracker returns references or no field at all, with no notion of an entry that is present and
	// blank, so neither does this. Dropping empty entries to be kind about a trailing comma is what let
	// a value of `,` alone reduce to a confirmed empty list — a blocked ticket reading unblocked.
	test("a Blocked by entry that is blank is malformed, not skipped", () => {
		const repo = tempRepo();
		for (const value of ["1,", ",", " , ", "1,,2", ", 1"]) {
			const effort = writeEffort(repo, "effort", {
				"03-c.md": `# 03 — C\n\nStatus: open\nBlocked by: ${value}\n`,
			});
			expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		}
	});

	// Absence is the convention for open and unclaimed; blankness is a typo. Reading the two the same
	// way could hand out a ticket whose file was trying to mark it claimed.
	test("a field present with no value is malformed, not absent", () => {
		const repo = tempRepo();
		for (const line of ["Status:", "Type:", "Blocked by:"]) {
			const effort = writeEffort(repo, "effort", { "01-a.md": `# 01 — A\n\n${line}\n` });
			expect(() => readEffort(effort)).toThrow(/empty|has no/i);
		}
	});

	test("fields above the title are not this ticket's metadata", () => {
		const ticket = oneTicket(
			tempRepo(),
			"02-b.md",
			"<!-- preamble -->\n\nStatus: resolved\n\n# 02 — B\n\nStatus: open\n",
		);
		expect(ticket.state).toBe("open");
	});

	test("a hard line break separates fields, like a soft one", () => {
		const ticket = oneTicket(
			tempRepo(),
			"02-b.md",
			"# 02 — B\n\nStatus: open  \nType: grilling  \nBlocked by: 1\n",
		);
		expect(ticket.state).toBe("open");
		expect(ticket.type).toBe("grilling");
		expect(ticket.blockers.map((ref) => ref.key)).toEqual(["1"]);
	});

	test("a file whose first heading is a section, not a title, is refused", () => {
		const repo = tempRepo();
		for (const first of ["## Notes", "### Question"]) {
			const effort = writeEffort(repo, "effort", {
				"01-a.md": `${first}\n\nStatus: claimed\nBlocked by: 2\n`,
			});
			expect(() => readEffort(effort)).toThrow(/title/);
		}
	});

	test("reads the skill's no-blockers prose as no blockers, not as a malformed list", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-first.md",
			"# 01 — First\n\n**Blocked by:** None — can start immediately\n\n**Status:** ready-for-agent\n",
		);
		expect(ticket.blockers).toEqual([]);
	});
});

describe("readEffort: the Status vocabulary", () => {
	const cases: Array<[string, "open" | "closed", boolean]> = [
		["open", "open", false],
		["claimed", "open", true],
		["resolved", "closed", false],
		["ready-for-agent", "open", false],
		["ready-for-human", "open", false],
		["needs-triage", "open", false],
		["needs-info", "open", false],
		["wontfix", "closed", false],
	];

	for (const [value, state, claimed] of cases) {
		test(`Status: ${value} reads as ${state}${claimed ? " and claimed" : ""}`, () => {
			const ticket = oneTicket(tempRepo(), "01-a.md", `# 01 — A\n\nStatus: ${value}\n`);
			expect(ticket.state).toBe(state);
			expect(ticket.claim === null).toBe(!claimed);
		});
	}

	test("a claim records that the ticket is claimed even though markdown names no claimant", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: claimed\n");
		expect(ticket.claim).toEqual({ by: null });
	});

	test("an absent Status line reads as open and unclaimed, which is the wayfinder convention", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nType: grilling\n");
		expect(ticket.state).toBe("open");
		expect(ticket.claim).toBeNull();
	});

	// An object literal indexed by a free-form string answers for Object.prototype's members, so
	// `Status: constructor` read as recognised, `state` came back undefined, and the blocker seeded
	// as confirmed-closed — the guard against the forbidden collapse was the thing delivering it.
	for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
		test(`Status: ${inherited} is unrecognised, not inherited from Object.prototype`, () => {
			const effort = writeEffort(tempRepo(), "effort", {
				"01-a.md": `# 01 — A\n\nStatus: ${inherited}\n`,
			});
			expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		});
	}

	test("a blocker whose Status is an inherited property name never prunes as satisfied", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-dependent.md": "# 01 — Dependent\n\nStatus: open\nBlocked by: 2\n",
			"02-blocker.md": "# 02 — Blocker\n\nStatus: constructor\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	// The decoration allowance exists for `Blocked by:`, and applying it to `Status:` too meant a
	// quoted or listed status became the ticket's own. Quoting a *completion* is the likely case, so
	// this errs toward `resolved` — which seeds a confirmed-met blocker and prunes its dependents.
	test("a decorated or indented Status is prose, not the ticket's own state", () => {
		const repo = tempRepo();
		const ticket = oneTicket(repo, "01-a.md", "# 01 — A\n\nFrom the standup:\n\n- Status: resolved\n");
		expect(ticket.state).toBe("open");
	});

	test("a quoted Status does not prune a dependent whose blocker is still open", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-blocker.md": "# 01 — Blocker\n\nQuoting the form:\n\n- Status: resolved\n",
			"02-dependent.md": "# 02 — Dependent\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.state).toBe("open");
		expect(tickets.get("2")!.blocked).toBe("blocked");
	});

	test("an unrecognised Status fails loudly naming the value, rather than yielding no candidates", () => {
		const repo = tempRepo();
		const effort = writeEffort(repo, "effort", {
			"01-a.md": "# 01 — A\n\nStatus: in-flight\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		expect(() => readEffort(effort)).toThrow(/in-flight/);
	});

	test("Status matching ignores case so a capitalised value is not an unrecognised one", () => {
		expect(oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: Resolved\n").state).toBe("closed");
	});
});

describe("readEffort: malformed input fails loudly", () => {
	function expectRejected(body: string, pattern: RegExp): void {
		const effort = writeEffort(tempRepo(), "effort", { "01-a.md": body });
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		expect(() => readEffort(effort)).toThrow(pattern);
	}

	// `/^none\b/i` matched on its first word alone, so a blocker appended to an existing "None" line
	// was discarded and the ticket read a confident unblocked.
	test("a blocker stated after a leading None clause is not discarded", () => {
		const repo = tempRepo();
		for (const value of ["none, 1", "None directly, but 2 must land first", "None known yet"]) {
			const effort = writeEffort(repo, "effort", {
				"01-a.md": `# 01 — A\n\nStatus: open\nBlocked by: ${value}\n`,
			});
			expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		}
	});

	test("the skill's None prose is still read as no blockers", () => {
		const repo = tempRepo();
		for (const value of ["None — can start immediately", "none", "None – nothing to wait on"]) {
			const ticket = oneTicket(repo, "01-a.md", `# 01 — A\n\nStatus: open\nBlocked by: ${value}\n`);
			expect(ticket.blockers).toEqual([]);
		}
	});

	test("a diamond is not a cycle", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-root.md": "# 01 — Root\n\nStatus: open\n",
			"02-left.md": "# 02 — Left\n\nStatus: open\nBlocked by: 1\n",
			"03-right.md": "# 03 — Right\n\nStatus: open\nBlocked by: 1\n",
			"04-join.md": "# 04 — Join\n\nStatus: open\nBlocked by: 2, 3\n",
		});
		expect(byKey(readEffort(effort).tickets).get("4")!.blocked).toBe("blocked");
	});

	test("a ticket file numbered zero fails as a domain error, not a reference error", () => {
		const effort = writeEffort(tempRepo(), "effort", { "0-a.md": "# 0 — A\n" });
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("a Blocked by entry that is not a ticket number", () => {
		expectRejected("# 01 — A\n\nBlocked by: the substrate decision\n", /the substrate decision/);
	});

	test("a Blocked by entry of zero, which no effort numbers from", () => {
		expectRejected("# 01 — A\n\nBlocked by: 0\n", /Blocked by/);
	});

	test("a repeated field, where the two values may disagree", () => {
		expectRejected("# 01 — A\n\nStatus: open\nStatus: resolved\n", /Status/);
	});

	test("a file with no H1 title", () => {
		expectRejected("Type: grilling\nStatus: open\n", /title/);
	});

	// Skipped rather than refused, matching the dotfile and unreadable-entry stance: refusing would
	// take a whole effort down over one file, which this module declines to do for a blocking cycle.
	test("a non-ticket file alongside the tickets is skipped as junk", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\n",
			"README.md": "# Notes about this effort\n",
			"TEMPLATE.md": "# 00 — Template\n",
		});
		expect(readEffort(effort).tickets.map((ticket) => ticket.ref.key)).toEqual(["1"]);
	});

	test("two files claiming the same ticket number", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n",
			"1-a-again.md": "# 01 — A again\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	// Every filesystem failure on this path has to arrive as this module's own error, or a caller
	// catching MarkdownEffortError to report "not an effort" crashes on a raw errno instead.
	test("a scratch directory that is really a file", () => {
		const repo = tempRepo();
		writeFileSync(join(repo, ".scratch"), "not a directory\n");
		expect(() => discoverEfforts(repo)).toThrow(MarkdownEffortError);
	});

	test("a symlink loop in the issues directory", () => {
		const effort = writeEffort(tempRepo(), "effort", { "01-a.md": "# 01 — A\n" });
		const issues = join(effort, "issues");
		symlinkSync(join(issues, "03-loop.md"), join(issues, "02-loop.md"));
		symlinkSync(join(issues, "02-loop.md"), join(issues, "03-loop.md"));
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("a ticket file that cannot be read", () => {
		const effort = writeEffort(tempRepo(), "effort", { "01-a.md": "# 01 — A\n" });
		chmodSync(join(effort, "issues", "01-a.md"), 0o000);
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	// Skipped rather than refused, as before — but reported, because the entry was named like a ticket.
	// Silently handing back the smaller effort presents a partial set as the whole one, and the missing
	// ticket is only visible downstream if some other ticket happens to name it as a blocker.
	test("a dangling symlink is still skipped, and truncates the effort", () => {
		const effort = writeEffort(tempRepo(), "effort", { "01-a.md": "# 01 — A\n\nStatus: open\n" });
		symlinkSync(join(effort, "issues", "nope.md"), join(effort, "issues", "02-gone.md"));
		expect(readEffort(effort).tickets.map((ticket) => ticket.ref.key)).toEqual(["1"]);
		expect(readEffort(effort).truncated).toBe(true);
	});

	test("junk that was never a ticket leaves the effort whole", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\n",
			"README.md": "# Notes\n",
		});
		symlinkSync(join(effort, "issues", "nope.md"), join(effort, "issues", "notes-gone.md"));
		expect(readEffort(effort).truncated).toBe(false);
	});

	test("an effort directory with no map file", () => {
		const repo = tempRepo();
		mkdirSync(join(repo, ".scratch", "no-map", "issues"), { recursive: true });
		expect(() => readEffort(join(repo, ".scratch", "no-map"))).toThrow(MarkdownEffortError);
	});

});

// The contract, stated positively so the decision is visible rather than implied by absent tests.
// Per ADR-0010 this adapter reads the accepted grammar and infers nothing from anything else: markdown
// is the fixture substrate that proves the contract shape, and the trackers that matter carry blocking
// as structured data rather than as prose. Every shape below was once refused by a heuristic, and each
// of those heuristics also refused something legitimate.
describe("readEffort: content outside the grammar is body", () => {
	const outsideTheGrammar: Array<[string, string]> = [
		["a field under a name the grammar does not have", "Requires: 1"],
		["a field the grammar has, outside the header region", "Blocked by: 1"],
	];

	for (const [name, body] of outsideTheGrammar) {
		test(`${name} is not read and does not refuse the effort`, () => {
			const ticket = oneTicket(tempRepo(), "02-b.md", `# 02 — B\n\nStatus: open\n\n## Notes\n\n${body}\n`);
			expect(ticket.blockers).toEqual([]);
			expect(ticket.state).toBe("open");
		});
	}

	test("a field wearing an inline form no producer emits is not a field", () => {
		const repo = tempRepo();
		const ticket = oneTicket(repo, "01-a.md", "# 01 — A\n\n_Status_: resolved\n");
		expect(ticket.state).toBe("open");
	});

	test("a link whose text ends in a field name is not a field", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			"# 01 — A\n\n[Status](https://example.com/issues/1): resolved\n",
		);
		expect(ticket.state).toBe("open");
	});

	test("an escaped colon does not reassemble into a field", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus\\: resolved\n").state).toBe("open");
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus: open\nBlocked by\\: 1\n").blockers).toEqual([]);
	});

	// Cleaning the markers off instead would accept a shape the rule excludes, and `Type` is the one field
	// with no validation to notice that it had.
	test("a field whose value wears markup is not a field", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus: open\nType: *decision*\n").type).toBeNull();
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus: open\nType: decision\n").type).toBe("decision");
	});

	// Both fixtures refused before per-line tracking, by different mechanisms: without a real Status the
	// stray closing marker made a garbage value, and with one it made a second Status field.
	test("emphasis spanning a hard break does not refuse the effort", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\n_see also  \nStatus: resolved_\n").state).toBe("open");
		const withField = oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus: open\n\n_see also  \nStatus: resolved_\n");
		expect(withField.state).toBe("open");
	});

	test("plain and bold are both still read", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\nStatus: resolved\n").state).toBe("closed");
		expect(oneTicket(repo, "01-a.md", "# 01 — A\n\n**Status:** resolved\n").state).toBe("closed");
	});

	test("the grammar itself is still read, and still validated", () => {
		const repo = tempRepo();
		const ticket = oneTicket(repo, "02-b.md", "# 02 — B\n\n**Status:** ready-for-agent\n\n**Blocked by:** 1\n");
		expect(ticket.blockers.map((ref) => ref.key)).toEqual(["1"]);
		expect(ticket.labels).toEqual(["ready-for-agent"]);

		const bad = writeEffort(repo, "bad", { "01-a.md": "# 01 — A\n\nStatus: in-flight\n" });
		expect(() => readEffort(bad)).toThrow(/not a recognised status/);
	});
});

describe("readEffort: blockedness", () => {
	test("a ticket with no blockers is unblocked", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: open\n");
		expect(ticket.blocked).toBe("unblocked");
	});

	test("an open blocker blocks; a resolved blocker does not", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-open-blocker.md": "# 01 — Open blocker\n\nStatus: open\n",
			"02-resolved-blocker.md": "# 02 — Resolved blocker\n\nStatus: resolved\n",
			"03-blocked.md": "# 03 — Blocked\n\nStatus: open\nBlocked by: 1\n",
			"04-satisfied.md": "# 04 — Satisfied\n\nStatus: open\nBlocked by: 2\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("3")!.blocked).toBe("blocked");
		expect(tickets.get("4")!.blocked).toBe("unblocked");
	});

	test("blocking is transitive through an open chain", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-root.md": "# 01 — Root\n\nStatus: open\n",
			"02-middle.md": "# 02 — Middle\n\nStatus: open\nBlocked by: 1\n",
			"03-leaf.md": "# 03 — Leaf\n\nStatus: open\nBlocked by: 2\n",
		});
		expect(byKey(readEffort(effort).tickets).get("3")!.blocked).toBe("blocked");
	});

	test("a resolved blocker is pruned, so its own open upstream does not leak through", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-open-upstream.md": "# 01 — Open upstream\n\nStatus: open\n",
			"02-resolved-middle.md": "# 02 — Resolved middle\n\nStatus: resolved\nBlocked by: 1\n",
			"03-leaf.md": "# 03 — Leaf\n\nStatus: open\nBlocked by: 2\n",
		});
		expect(byKey(readEffort(effort).tickets).get("3")!.blocked).toBe("unblocked");
	});

	// The convention keys blocking on `resolved` specifically, not on closedness. A wontfix blocker
	// is closed without the dependency ever having been met, so neither "satisfied" nor "still to
	// come" is true of it and only unknown is honest — a human judges whether the abandoned
	// dependency actually mattered.
	test("a wontfix blocker leaves its dependent unknown, rather than pruning as satisfied", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-abandoned.md": "# 01 — Abandoned\n\nStatus: wontfix\n",
			"02-built-on-it.md": "# 02 — Built on it\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.state).toBe("closed");
		expect(tickets.get("2")!.blocked).toBe("unknown");
	});

	test("a resolved blocker still prunes, so wontfix is the narrow exception", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-resolved.md": "# 01 — Resolved\n\nStatus: resolved\n",
			"02-dependent.md": "# 02 — Dependent\n\nStatus: open\nBlocked by: 1\n",
		});
		expect(byKey(readEffort(effort).tickets).get("2")!.blocked).toBe("unblocked");
	});

	// The shared traversal tolerates cycles by design, so the adapter does not refuse them — doing so
	// would make markdown disagree with the other trackers about which graphs are legal. Both err
	// toward blocked, which is the safe direction.
	test("a ticket blocking itself reads blocked rather than refusing the effort", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: open\nBlocked by: 1\n");
		expect(ticket.blocked).toBe("blocked");
	});

	test("a mutual blocking cycle terminates and reads blocked on both sides", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\nBlocked by: 2\n",
			"02-b.md": "# 02 — B\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.blocked).toBe("blocked");
		expect(tickets.get("2")!.blocked).toBe("blocked");
	});

	test("a Blocked by reference to a ticket absent from the effort is unknown, never unblocked", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\nBlocked by: 99\n",
		});
		expect(byKey(readEffort(effort).tickets).get("1")!.blocked).toBe("unknown");
	});

	test("a confirmed open blocker outranks an unresolvable one", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-open.md": "# 01 — Open\n\nStatus: open\n",
			"02-a.md": "# 02 — A\n\nStatus: open\nBlocked by: 1, 99\n",
		});
		expect(byKey(readEffort(effort).tickets).get("2")!.blocked).toBe("blocked");
	});

	test("a resolved ticket's own blockedness is still reported, not skipped", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-open.md": "# 01 — Open\n\nStatus: open\n",
			"02-resolved.md": "# 02 — Resolved\n\nStatus: resolved\nBlocked by: 1\n",
		});
		expect(byKey(readEffort(effort).tickets).get("2")!.blocked).toBe("blocked");
	});

	// The blocking graph reads every ticket, so a claimed one — which no candidate set would
	// include — still blocks. It blocks because it is open, not because it is excluded.
	test("a claimed ticket, excluded from any candidate set, still blocks", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-blocker.md": "# 01 — Blocker\n\nStatus: claimed\n",
			"02-blocked.md": "# 02 — Blocked\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.claim).toEqual({ by: null });
		expect(tickets.get("2")!.blocked).toBe("blocked");
	});
});

describe("readEffort: the normalized ticket surface", () => {
	// Unpadded names, so the two orders differ: readdirSync gives 1, 10, 9 lexicographically.
	test("tickets come back ordered by number, not by filename", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"1-a.md": "# 1 — A\n",
			"9-i.md": "# 9 — I\n",
			"10-j.md": "# 10 — J\n",
		});
		expect(readEffort(effort).tickets.map((ticket) => ticket.ref.key)).toEqual(["1", "9", "10"]);
	});

	test("markdown has no web UI, so a ticket carries no url", () => {
		expect(oneTicket(tempRepo(), "01-a.md", "# 01 — A\n").url).toBeNull();
	});

	test("Type is not mapped onto a label", () => {
		const ticket = oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nType: research\n");
		expect(ticket.type).toBe("research");
		expect(ticket.labels).toEqual([]);
	});

	test("a ticket with no Type field has no type", () => {
		expect(oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nStatus: open\n").type).toBeNull();
	});

	// Without this the triage role is consumed into open/closed and discarded, so `needs-info`
	// becomes indistinguishable from `open` and the candidate filter has nothing to act on.
	test("a triage-role Status is carried as a label so a candidate filter can see it", () => {
		const repo = tempRepo();
		for (const role of ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human"]) {
			const ticket = oneTicket(repo, "01-a.md", `# 01 — A\n\nStatus: ${role}\n`);
			expect(ticket.labels).toEqual([role]);
			expect(ticket.state).toBe("open");
		}
	});

	test("the wayfinder state values are not triage roles, so they carry no label", () => {
		const repo = tempRepo();
		for (const value of ["open", "claimed", "resolved"]) {
			expect(oneTicket(repo, "01-a.md", `# 01 — A\n\nStatus: ${value}\n`).labels).toEqual([]);
		}
	});

});

/**
 * The write half of the claim step. Every shape here stands in for the one column of the contract
 * ADR-0010 gives markdown's `Status:` — a claim recorded, or none — in the forms the two authored
 * producers write it: plain, and bold.
 */
describe("withStatus", () => {
	const PATH = "issues/01-a.md";

	test("replaces the value of a plain field, leaving the rest of the file alone", () => {
		const before = "# 01 — A\n\nType: task\nStatus: open\nBlocked by: 02\n\n## Notes\n\nProse.\n";
		expect(withStatus(before, "claimed", PATH)).toBe(
			"# 01 — A\n\nType: task\nStatus: claimed\nBlocked by: 02\n\n## Notes\n\nProse.\n",
		);
	});

	test("keeps a bold field bold, in either of the two places the emphasis is written", () => {
		expect(withStatus("# 01 — A\n\n**Status:** open\n", "claimed", PATH)).toBe("# 01 — A\n\n**Status:** claimed\n");
		expect(withStatus("# 01 — A\n\n**Status**: open\n", "claimed", PATH)).toBe("# 01 — A\n\n**Status**: claimed\n");
		expect(withStatus("# 01 — A\n\n__Status:__ open\n", "claimed", PATH)).toBe("# 01 — A\n\n__Status:__ claimed\n");
	});

	test("adds the field under the title where the file has none, since absence is how unclaimed is written", () => {
		expect(withStatus("# 01 — A\n\nType: task\n", "claimed", PATH)).toBe("# 01 — A\n\nStatus: claimed\n\nType: task\n");
	});

	// A writer with its own idea of where the header region ends would edit these, and the reader would
	// go on reporting the ticket unclaimed with no sign anything had been written.
	test("never writes over a Status line the reader does not read", () => {
		const belowAHeading = "# 01 — A\n\nType: task\n\n## Notes\n\nStatus: resolved\n";
		expect(withStatus(belowAHeading, "claimed", PATH)).toBe(
			"# 01 — A\n\nStatus: claimed\n\nType: task\n\n## Notes\n\nStatus: resolved\n",
		);

		const insideASnippet = "# 01 — A\n\nType: task\n\n```\nStatus: resolved\n```\n";
		expect(withStatus(insideASnippet, "claimed", PATH)).toBe(
			"# 01 — A\n\nStatus: claimed\n\nType: task\n\n```\nStatus: resolved\n```\n",
		);
	});

	test("what it writes is what the reader reads back", () => {
		const repo = tempRepo();
		for (const before of ["# 01 — A\n\nStatus: open\n", "# 01 — A\n\n**Status:** open\n", "# 01 — A\n\nType: task\n"]) {
			const effortRoot = writeEffort(repo, "an-effort", { "01-a.md": withStatus(before, "claimed", PATH) });
			expect(readEffort(effortRoot).tickets[0]?.claim).toEqual({ by: null });
		}
	});

	// Not a grammar shape but a file-encoding one: a checkout can hand back CRLF, and rewriting one
	// line in LF leaves a file whose endings disagree with themselves.
	test("leaves the file's line endings as it found them", () => {
		expect(withStatus("# 01 — A\r\n\r\nStatus: open\r\n", "claimed", PATH)).toBe("# 01 — A\r\n\r\nStatus: claimed\r\n");
	});

	// The endings a lexer normalises away that a line split does not: the counts drift, so no line is
	// found to rewrite and the field is refused rather than written over whatever now sits at that
	// offset. The reader accepts such a file, so the two disagree — knowingly, in the safe direction.
	test("refuses rather than rewriting a line it can no longer locate", () => {
		expect(() => withStatus("# 01 — A\r\rStatus: open\r", "claimed", PATH)).toThrow(MarkdownEffortError);
	});

	test("refuses a file with no title rather than writing a field nothing would read", () => {
		expect(() => withStatus("Status: open\n", "claimed", PATH)).toThrow(MarkdownEffortError);
	});
});

describe("readTicketFile", () => {
	test("reads one ticket without its effort, since a claim is verified against the file it wrote", () => {
		const repo = tempRepo();
		const effortRoot = writeEffort(repo, "an-effort", { "01-a.md": "# 01 — A\n\nStatus: claimed\n" });
		const ticket = readTicketFile(join(effortRoot, "issues", "01-a.md"));
		expect(ticket.ref.key).toBe("1");
		expect(ticket.claim).toEqual({ by: null });
	});

	test("refuses a path not named like a ticket, rather than inventing a number for it", () => {
		const repo = tempRepo();
		const effortRoot = writeEffort(repo, "an-effort", { "01-a.md": "# 01 — A\n\nStatus: open\n" });
		expect(() => readTicketFile(join(effortRoot, "map.md"))).toThrow(MarkdownEffortError);
	});
});
