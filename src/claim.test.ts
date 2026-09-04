import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimError, markdownClaimer } from "./claim";
import { readTicketFile } from "./markdown-adapter";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One ticket file on a real disk, since the claim step's whole job is what it writes there. */
function ticketFile(body: string, name = "01-a.md"): string {
	const root = mkdtempSync(join(tmpdir(), "nextup-claim-"));
	roots.push(root);
	mkdirSync(join(root, "issues"));
	const path = join(root, "issues", name);
	writeFileSync(path, body);
	return path;
}

function read(path: string): string {
	return readFileSync(path, "utf8");
}

/**
 * A read-back that reports the ticket unclaimed however it was written — a tracker accepting a claim
 * it did not take. The first read, the one the claim step makes before writing, is the real thing.
 */
function unclaimed(): (target: string) => ReturnType<typeof readTicketFile> {
	let reads = 0;
	return (target) => {
		const ticket = readTicketFile(target);
		return ++reads > 1 ? { ...ticket, claim: null } : ticket;
	};
}

describe("markdownClaimer", () => {
	test("writes the claim into the status field, which is the only claim signal markdown has", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const hold = markdownClaimer(readTicketFile(path)).claim();

		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\n");
		expect(hold.ref.key).toBe("1");
	});

	// GitHub, GitLab and Jira all record who holds a claim. Markdown records only that one is held, and
	// saying so is what stops a caller reading a null claimant as nobody having claimed it.
	test("names no claimant, because the tracker records none", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		expect(markdownClaimer(readTicketFile(path)).claim().claimant).toBeNull();
	});

	test("refuses a ticket claimed since it was selected, leaving the file untouched", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		writeFileSync(path, "# 01 — A\n\nStatus: claimed\n");

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\n");
	});

	test("refuses a ticket closed since it was selected, leaving the file untouched", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		writeFileSync(path, "# 01 — A\n\nStatus: resolved\n");

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: resolved\n");
	});

	test("refuses when the ticket file is gone, with nothing written", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		rmSync(path);

		expect(() => claimer.claim()).toThrow(ClaimError);
	});

	test("puts the file back when the claim it wrote does not read back as one", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path), { readBack: unclaimed() });

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("puts the file back when the claim it wrote cannot be read at all", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		let reads = 0;
		const claimer = markdownClaimer(readTicketFile(path), {
			readBack: (target) => {
				if (++reads > 1) throw new Error("gone");
				return readTicketFile(target);
			},
		});

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("a released claim leaves nothing to release a second time", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();

		expect(claimer.release()).toEqual({ released: true });
		expect(claimer.release().released).toBe(false);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("releases by restoring exactly what the file said before, triage role and all", () => {
		const path = ticketFile("# 01 — A\n\n**Status:** ready-for-agent\n\nProse.\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		expect(read(path)).toBe("# 01 — A\n\n**Status:** claimed\n\nProse.\n");

		expect(claimer.release()).toEqual({ released: true });
		expect(read(path)).toBe("# 01 — A\n\n**Status:** ready-for-agent\n\nProse.\n");
	});

	test("refuses to release over an edit made since the claim, rather than discarding it", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		writeFileSync(path, "# 01 — A\n\nStatus: claimed\nBlocked by: 02\n");

		const outcome = claimer.release();
		expect(outcome.released).toBe(false);
		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\nBlocked by: 02\n");
	});

	test("reports a release of a claim it never took rather than writing anything", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		expect(markdownClaimer(readTicketFile(path)).release().released).toBe(false);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("reports a release it could not write, rather than claiming the ticket is free", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		rmSync(path);

		expect(claimer.release().released).toBe(false);
	});

	test("claims a ticket whose file records no status, since absence is how unclaimed is written", () => {
		const path = ticketFile("# 01 — A\n\nType: task\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		expect(readTicketFile(path).claim).toEqual({ by: null });

		expect(claimer.release()).toEqual({ released: true });
		expect(read(path)).toBe("# 01 — A\n\nType: task\n");
	});
});
