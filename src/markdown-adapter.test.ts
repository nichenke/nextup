import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MarkdownEffortError,
	discoverEfforts,
	readEffort,
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

	test("returns nothing when the repo has no scratch directory at all", () => {
		expect(discoverEfforts(tempRepo())).toEqual([]);
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

	// The H1 carries a different number from the filename, so this can tell which one was read.
	test("takes the ticket number from the filename, not the H1, and strips its padding", () => {
		const ticket = oneTicket(tempRepo(), "07-seventh.md", "# 42 — Seventh\n");
		expect(ticket.ref.key).toBe("7");
		expect(ticket.title).toBe("Seventh");
	});

	test("keeps a title that carries no number prefix intact", () => {
		const ticket = oneTicket(tempRepo(), "01-plain.md", "# Just a title\n");
		expect(ticket.title).toBe("Just a title");
	});

	test("keeps an en dash or hyphen number prefix out of the title too", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 01 – En dashed\n").title).toBe("En dashed");
		expect(oneTicket(repo, "01-a.md", "# 01 - Hyphenated\n").title).toBe("Hyphenated");
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

	test("parses a file written with CRLF line endings", () => {
		const ticket = oneTicket(
			tempRepo(),
			"02-a.md",
			"# 02 — Carriage returned\r\n\r\nType: grilling\r\nStatus: resolved\r\nBlocked by: 1\r\n",
		);
		expect(ticket.title).toBe("Carriage returned");
		expect(ticket.type).toBe("grilling");
		expect(ticket.state).toBe("closed");
		expect(ticket.blockers).toEqual([
			{ tracker: "markdown", repo: null, host: null, key: "1" },
		]);
	});

	// Only ATX `##` ended the header, so a setext-underlined heading left the whole body inside it and
	// body prose became the ticket's own Status — which, read as resolved, prunes its dependents.
	test("a setext-underlined heading ends the header region, like an ATX one", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-blocker.md": "# 01 — Blocker\n\nNotes\n-----\n\nStatus: resolved\n",
			"02-dependent.md": "# 02 — Dependent\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.state).toBe("open");
		expect(tickets.get("2")!.blocked).toBe("blocked");
	});

	test("a thematic break ends the header region too", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			"# 01 — A\n\nStatus: open\n\n---\n\nStatus: resolved was the old value.\n",
		);
		expect(ticket.state).toBe("open");
	});

	// The counterpart to the Blocked by rule: a Status line below a heading stays prose, because an
	// Answer or Comments section legitimately quotes a past value.
	test("a Status line below the first section heading is body prose, not the ticket's field", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			"# 01 — A\n\nStatus: open\n\n## Answer\n\nStatus: resolved was the old value.\n",
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
	test("parses bold fields, with the colon inside or outside the bold markers", () => {
		const ticket = oneTicket(
			tempRepo(),
			"03-bolded.md",
			[
				"# 03 — Bolded",
				"",
				"**What to build:** the thing.",
				"",
				"**Blocked by:** 1, 2",
				"",
				"**Status**: ready-for-agent",
				"",
				"- [ ] Acceptance criterion 1",
			].join("\n"),
		);
		expect(ticket.state).toBe("open");
		expect(ticket.claim).toBeNull();
		expect(ticket.blockers).toEqual([
			{ tracker: "markdown", repo: null, host: null, key: "1" },
			{ tracker: "markdown", repo: null, host: null, key: "2" },
		]);
	});

	test("ignores a field-shaped line inside an inlined code snippet", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			[
				"# 01 — A",
				"",
				"**Status:** ready-for-agent",
				"",
				"```ts",
				"Status: resolved",
				"Blocked by: 99",
				"```",
				"",
				"- [ ] Acceptance criterion 1",
			].join("\n"),
		);
		expect(ticket.state).toBe("open");
		expect(ticket.blockers).toEqual([]);
	});

	test("a heading inside a code snippet does not end the header scan early", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			[
				"# 01 — A",
				"",
				"```md",
				"## Question",
				"```",
				"",
				"**Status:** resolved",
				"**Blocked by:** 2",
			].join("\n"),
		);
		expect(ticket.state).toBe("closed");
		expect(ticket.blockers).toEqual([
			{ tracker: "markdown", repo: null, host: null, key: "2" },
		]);
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

	// FIELD_LINE is anchored, so a Blocked by wearing any markdown decoration missed it entirely and
	// the ticket read unblocked. A bullet and a blockquote now parse; a shape that cannot be read as
	// a field is refused rather than dropped.
	test("a bulleted or blockquoted Blocked by is read, not dropped", () => {
		const repo = tempRepo();
		for (const line of ["- Blocked by: 2", "* Blocked by: 2", "> Blocked by: 2"]) {
			const ticket = oneTicket(repo, "01-a.md", `# 01 — A\n\nStatus: open\n${line}\n`);
			expect(ticket.blockers.map((ref) => ref.key)).toEqual(["2"]);
		}
	});

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

	test("a blocker field under a name this parser does not read is refused, not dropped", () => {
		const repo = tempRepo();
		for (const line of ["Blocked-by: 2", "Blockers: 2", "Depends on: 2", "Blocked by 2"]) {
			const effort = writeEffort(repo, "effort", {
				"01-a.md": `# 01 — A\n\nStatus: open\n${line}\n`,
			});
			expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
		}
	});

	test("a second H1 in the header is refused, like every other duplicated field", () => {
		expectRejected("# 01 — A\n\n# 01 — A again\n\nStatus: open\n", /title/);
	});

	test("a Blocked by naming ticket numbers in a shape that cannot be read as a field", () => {
		expectRejected("# 01 — A\n\nStatus: open\n\n| Blocked by | 2 |\n", /Blocked by/);
	});

	test("prose merely mentioning being blocked is not mistaken for a declaration", () => {
		const ticket = oneTicket(
			tempRepo(),
			"01-a.md",
			"# 01 — A\n\nStatus: open\n\n## Notes\n\nThis was blocked by the substrate decision for a while.\n",
		);
		expect(ticket.blockers).toEqual([]);
	});

	test("a ticket file numbered zero fails as a domain error, not a reference error", () => {
		const effort = writeEffort(tempRepo(), "effort", { "0-a.md": "# 0 — A\n" });
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("a ticket listing itself as its own blocker, which is always an authoring error", () => {
		expectRejected("# 01 — A\n\nStatus: open\nBlocked by: 1\n", /itself/);
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

	test("a file in the issues directory whose name carries no ticket number", () => {
		const effort = writeEffort(tempRepo(), "effort", { "notes.md": "# Notes\n" });
		expect(() => readEffort(effort)).toThrow(/notes\.md/);
	});

	test("two files claiming the same ticket number", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n",
			"1-a-again.md": "# 01 — A again\n",
		});
		expect(() => readEffort(effort)).toThrow(MarkdownEffortError);
	});

	test("an effort directory with no map file", () => {
		const repo = tempRepo();
		mkdirSync(join(repo, ".scratch", "no-map", "issues"), { recursive: true });
		expect(() => readEffort(join(repo, ".scratch", "no-map"))).toThrow(MarkdownEffortError);
	});

	// The asymmetry is the point: a missed Status reads open and unclaimed, which a human sees at
	// launch, but a missed Blocked by reads unblocked — the one state the domain forbids. So a
	// Blocked by line is policed everywhere, while a Status line below the header stays prose.
	test("a Blocked by line below the first section heading, which would otherwise read unblocked", () => {
		expectRejected(
			"# 01 — A\n\nStatus: open\n\n## Dependencies\n\nBlocked by: 1\n",
			/Blocked by/,
		);
	});

	test("a Blocked by line in a section quoting a past state, rather than guessing at its intent", () => {
		expectRejected("# 01 — A\n\nStatus: resolved\n\n## Answer\n\nBlocked by: 2 originally.\n", /Blocked by/);
	});

	test("an unterminated code fence, which otherwise swallows every field after it", () => {
		expectRejected("# 01 — A\n\n```\n\nStatus: resolved\nBlocked by: 1\n", /fence/);
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

	test("a blocking cycle terminates rather than hanging", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: open\nBlocked by: 2\n",
			"02-b.md": "# 02 — B\n\nStatus: open\nBlocked by: 1\n",
		});
		const tickets = byKey(readEffort(effort).tickets);
		expect(tickets.get("1")!.blocked).toBe("blocked");
		expect(tickets.get("2")!.blocked).toBe("blocked");
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

	test("Type with an empty value is absent, matching how an empty Status is read", () => {
		expect(oneTicket(tempRepo(), "01-a.md", "# 01 — A\n\nType:\n").type).toBeNull();
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

	test("a title whose first word begins with a number is not eaten by the number prefix", () => {
		const repo = tempRepo();
		expect(oneTicket(repo, "01-a.md", "# 3-way merge conflict resolution\n").title).toBe(
			"3-way merge conflict resolution",
		);
		expect(oneTicket(repo, "01-a.md", "# 2-phase commit\n").title).toBe("2-phase commit");
	});

	test("a zero-padded Blocked by reference resolves to the same ticket as its bare form", () => {
		const effort = writeEffort(tempRepo(), "effort", {
			"01-a.md": "# 01 — A\n\nStatus: resolved\n",
			"02-b.md": "# 02 — B\n\nStatus: open\nBlocked by: 01\n",
		});
		const ticket = byKey(readEffort(effort).tickets).get("2")!;
		expect(ticket.blockers).toEqual([
			{ tracker: "markdown", repo: null, host: null, key: "1" },
		]);
		expect(ticket.blocked).toBe("unblocked");
	});
});
