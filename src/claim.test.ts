import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaimError, markdownClaimer } from "./claim";
import { readTicketFile } from "./markdown-adapter";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		// A test that made a directory unwritable has to hand the permission back, or the cleanup that
		// removes it fails and every later test inherits the leftovers.
		chmodSync(join(root, "issues"), 0o755);
		rmSync(root, { recursive: true, force: true });
	}
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
 * A read-back reporting the ticket unclaimed however it was written — a tracker accepting a claim it
 * did not take. Only the verification reads through this; what the claim step decides from is the one
 * read of the file it makes itself.
 */
function unclaimed(target: string): ReturnType<typeof readTicketFile> {
	return { ...readTicketFile(target), claim: null };
}

describe("markdownClaimer", () => {
	// A raw filesystem error escaping here reaches the CLI's `throw cause` and kills the process on an
	// exit code that means something else entirely.
	test("reports every failure it has as a ClaimError, whatever went wrong", () => {
		const gone = ticketFile("# 01 — A\n\nStatus: open\n");
		const goneClaimer = markdownClaimer(readTicketFile(gone));
		rmSync(gone);

		const readOnly = ticketFile("# 01 — A\n\nStatus: open\n");
		chmodSync(readOnly, 0o444);

		const link = ticketFile("# 01 — A\n\nStatus: open\n", "01-target.md");
		const linked = join(dirname(link), "01-a.md");
		symlinkSync(link, linked);

		const malformed = ticketFile("# 01 — A\n\n**Status: op**en\n");

		const claimers = [
			goneClaimer,
			markdownClaimer(readTicketFile(readOnly)),
			markdownClaimer(readTicketFile(linked)),
			markdownClaimer(readTicketFile(malformed)),
		];
		for (const claimer of claimers) {
			expect(() => claimer.claim()).toThrow(ClaimError);
		}
	});

	test("writes the claim into the status field, which is the only claim signal markdown has", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const hold = markdownClaimer(readTicketFile(path)).claim();

		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\n");
		expect(hold.ref.key).toBe("1");
	});

	test("holds a claim with no claimant, rather than no claim", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		expect(markdownClaimer(readTicketFile(path)).claim().claimant).toEqual({ by: null });
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

	test("refuses when the ticket file is gone, with nothing written, as a pick to come back for", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		rmSync(path);

		expect(() => claimer.claim()).toThrow(expect.objectContaining({ kind: "unavailable" }));
	});

	test("says whether the ticket was unavailable or the ticket set was wrong", () => {
		const taken = ticketFile("# 01 — A\n\nStatus: claimed\n");
		expect(() => markdownClaimer(readTicketFile(taken)).claim()).toThrow(
			expect.objectContaining({ kind: "unavailable" }),
		);

		const malformed = ticketFile("# 01 — A\n\n**Status: op**en\n");
		expect(() => markdownClaimer(readTicketFile(malformed)).claim()).toThrow(
			expect.objectContaining({ kind: "ticket-set" }),
		);

		const readOnly = ticketFile("# 01 — A\n\nStatus: open\n");
		chmodSync(readOnly, 0o444);
		expect(() => markdownClaimer(readTicketFile(readOnly)).claim()).toThrow(
			expect.objectContaining({ kind: "ticket-set" }),
		);
	});

	test("says a rollback it could not make, rather than reporting only why the claim failed", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path), {
			readBack: (target) => {
				// The rollback is denied between the write landing and the read-back reporting it unclaimed,
				// which is the window that leaves a real claim on a ticket nobody is working.
				chmodSync(dirname(target), 0o555);
				return { ...readTicketFile(target), claim: null };
			},
		});

		expect(() => claimer.claim()).toThrow(expect.objectContaining({ kind: "stranded" }));
		chmodSync(dirname(path), 0o755);
		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\n");
	});

	// The claim is on the ticket, so it is still this claimer's to give back — answering
	// nothing-to-release would hand a caller an all-clear over a claim nobody is working.
	test("keeps a stranded claim releasable rather than reporting there was none", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path), {
			readBack: (target) => {
				chmodSync(dirname(target), 0o555);
				return { ...readTicketFile(target), claim: null };
			},
		});

		expect(() => claimer.claim()).toThrow(ClaimError);
		chmodSync(dirname(path), 0o755);
		expect(claimer.release()).toEqual({ kind: "released" });
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("puts the file back when the claim it wrote does not read back as one", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path), { readBack: unclaimed });

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("puts the file back when the claim it wrote cannot be read at all", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path), {
			readBack: () => {
				throw new Error("gone");
			},
		});

		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("leaves the ticket exactly as it was when the write cannot happen", () => {
		const readOnlyFile = ticketFile("# 01 — A\n\nStatus: open\n");
		chmodSync(readOnlyFile, 0o444);
		expect(() => markdownClaimer(readTicketFile(readOnlyFile)).claim()).toThrow(ClaimError);
		expect(read(readOnlyFile)).toBe("# 01 — A\n\nStatus: open\n");

		const readOnlyDir = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(readOnlyDir));
		chmodSync(dirname(readOnlyDir), 0o555);
		expect(() => claimer.claim()).toThrow(ClaimError);
		expect(read(readOnlyDir)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("leaves no working file behind, whether the claim landed or not", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		markdownClaimer(readTicketFile(path)).claim();
		expect(readdirSync(dirname(path))).toEqual(["01-a.md"]);
	});

	test("claims over debris left by a claim that died mid-write", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		writeFileSync(`${path}.nextup`, "half a ticket, from a run that never finished\n");

		markdownClaimer(readTicketFile(path)).claim();

		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\n");
		expect(readdirSync(dirname(path))).toEqual(["01-a.md"]);
	});

	test("refuses a ticket file that is a symlink, leaving the link and its target alone", () => {
		const target = ticketFile("# 01 — A\n\nStatus: open\n", "01-target.md");
		const link = join(dirname(target), "01-a.md");
		symlinkSync(target, link);

		expect(() => markdownClaimer(readTicketFile(link)).claim()).toThrow(
			expect.objectContaining({ kind: "ticket-set" }),
		);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(read(target)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("releases by restoring exactly what the file said before, triage role and all", () => {
		const path = ticketFile("# 01 — A\n\n**Status:** ready-for-agent\n\nProse.\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		expect(read(path)).toBe("# 01 — A\n\n**Status:** claimed\n\nProse.\n");

		expect(claimer.release()).toEqual({ kind: "released" });
		expect(read(path)).toBe("# 01 — A\n\n**Status:** ready-for-agent\n\nProse.\n");
	});

	test("refuses to release over an edit made since the claim, rather than discarding it", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		writeFileSync(path, "# 01 — A\n\nStatus: claimed\nBlocked by: 02\n");

		expect(claimer.release().kind).toBe("stranded");
		expect(read(path)).toBe("# 01 — A\n\nStatus: claimed\nBlocked by: 02\n");
	});

	test("reports a release of a claim it never took rather than writing anything", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		expect(markdownClaimer(readTicketFile(path)).release()).toEqual({ kind: "nothing-to-release" });
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("a released claim leaves nothing to release a second time", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();

		expect(claimer.release()).toEqual({ kind: "released" });
		expect(claimer.release()).toEqual({ kind: "nothing-to-release" });
		expect(read(path)).toBe("# 01 — A\n\nStatus: open\n");
	});

	test("reports a release it could not write, rather than claiming the ticket is free", () => {
		const path = ticketFile("# 01 — A\n\nStatus: open\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		rmSync(path);

		expect(claimer.release().kind).toBe("stranded");
	});

	test("claims a ticket whose file records no status, since absence is how unclaimed is written", () => {
		const path = ticketFile("# 01 — A\n\nType: task\n");
		const claimer = markdownClaimer(readTicketFile(path));
		claimer.claim();
		expect(readTicketFile(path).claim).toEqual({ by: null });

		expect(claimer.release()).toEqual({ kind: "released" });
		expect(read(path)).toBe("# 01 — A\n\nType: task\n");
	});

	test("adds a field rather than overwriting a line the reader reads as prose", () => {
		const path = ticketFile("# 01 — A\n\nStatus: resolved — superseded by `02`\n");
		markdownClaimer(readTicketFile(path)).claim();

		expect(read(path)).toContain("Status: resolved — superseded by `02`");
		expect(readTicketFile(path).claim).toEqual({ by: null });
	});
});
