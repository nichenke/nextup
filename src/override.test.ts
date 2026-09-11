import { describe, expect, test } from "bun:test";
import { type Override, clearedByForce, decideOverride } from "./override";
import type { Ticket } from "./ticket";
import type { TicketRef } from "./ticket-ref";
import { type TicketRead, ticketRead } from "./ticket-set-read";

const REPO = "example/repo";

function ref(key: string): TicketRef {
	return { tracker: "github", repo: REPO, host: null, key };
}

function ticket(fields: Partial<Ticket> = {}): Ticket {
	return {
		ref: ref("1"),
		title: "A named ticket",
		state: "open",
		claim: null,
		blockers: [],
		url: `${REPO}/issues/1`,
		labels: [],
		...fields,
	};
}

/**
 * A read of one ticket, built the way every adapter has to build one — so no fixture here can state a blocking
 * answer in the ticket that the graph contradicts. `ticketRead`'s own docstring has why that matters.
 */
function read(one: Ticket, blockers: readonly { readonly ref: TicketRef; readonly open: boolean }[] = []): TicketRead {
	return ticketRead({ ticket: one, blockers, degraded: [] });
}

/** A read whose blocking field did not answer, which is `Unknown` rather than either of the other two states. */
function unreadableBlocking(one: Ticket = ticket()): TicketRead {
	return ticketRead({
		ticket: { ...one, blockers: "unknown" },
		blockers: [],
		degraded: [{ kind: "unreadable-blocking", tickets: 1, of: 1 }],
	});
}

function kinds(override: Override): readonly string[] {
	return (override.kind === "refused" ? override.refusals : override.forced).map((refusal) => refusal.kind);
}

describe("decideOverride, without --force", () => {
	test("starts a ticket that is open, unclaimed and confirmed unblocked", () => {
		const override = decideOverride({ read: read(ticket(), [{ ref: ref("2"), open: false }]), force: false });
		expect(override.kind).toBe("startable");
		expect(kinds(override)).toEqual([]);
		expect(override.target.blocked).toBe("unblocked");
	});

	// ADR-0037: `Unknown` is not blocked, so refusing one here would make the override stricter than the
	// ladder it overrides.
	test("starts a ticket whose blocking state the tracker could not report, saying that is what it is", () => {
		const override = decideOverride({ read: unreadableBlocking(), force: false });
		expect(override.kind).toBe("startable");
		expect(override.target.blocked).toBe("unknown");
	});

	// The collapse `CONTEXT.md` forbids, attempted through the constructor: a ticket whose blockers were never
	// read cannot come back confirmed, whatever openness a caller hands alongside it.
	test("cannot be built to confirm a ticket whose blockers were never read", () => {
		const override = decideOverride({
			read: ticketRead({ ticket: ticket({ blockers: "unknown" }), blockers: [{ ref: ref("2"), open: false }], degraded: [] }),
			force: false,
		});
		expect(override.target.blocked).toBe("unknown");
	});

	test("refuses a ticket with a confirmed open blocker, naming the blocker", () => {
		const blocker = ref("2");
		const override = decideOverride({ read: read(ticket({ blockers: [blocker] }), [{ ref: blocker, open: true }]), force: false });
		expect(override.kind).toBe("refused");
		expect(kinds(override)).toEqual(["blocked"]);
		if (override.kind !== "refused") throw new Error("expected a refusal");
		expect(override.refusals[0]).toEqual({ kind: "blocked", blockers: [blocker] });
	});

	// The tree's `mixed-blockers` shape is this: one closed blocker beside an open one.
	test("names only the blockers that are open, not every edge the ticket carries", () => {
		const open = ref("2");
		const closed = ref("3");
		const override = decideOverride({
			read: read(ticket({ blockers: [closed, open] }), [
				{ ref: closed, open: false },
				{ ref: open, open: true },
			]),
			force: false,
		});
		if (override.kind !== "refused") throw new Error("expected a refusal");
		expect(override.refusals[0]).toEqual({ kind: "blocked", blockers: [open] });
	});

	test("refuses a ticket somebody else holds, naming who", () => {
		const override = decideOverride({ read: read(ticket({ claim: { by: "someone" } })), force: false });
		expect(kinds(override)).toEqual(["claimed"]);
		if (override.kind !== "refused") throw new Error("expected a refusal");
		expect(override.refusals[0]).toEqual({ kind: "claimed", by: "someone" });
	});

	test("refuses a claim recording no claimant, rather than reading it as unclaimed", () => {
		const override = decideOverride({ read: read(ticket({ claim: { by: null } })), force: false });
		expect(kinds(override)).toEqual(["claimed"]);
	});

	test("refuses a closed ticket", () => {
		const override = decideOverride({ read: read(ticket({ state: "closed" })), force: false });
		expect(kinds(override)).toEqual(["closed"]);
	});

	test("names every check that failed, so one fix does not reveal the next", () => {
		const blocker = ref("2");
		const override = decideOverride({
			read: read(ticket({ state: "closed", claim: { by: "someone" }, blockers: [blocker] }), [{ ref: blocker, open: true }]),
			force: false,
		});
		expect(kinds(override)).toEqual(["closed", "claimed", "blocked"]);
	});
});

describe("decideOverride, with --force", () => {
	test("starts a blocked ticket, and carries the check it cleared", () => {
		const blocker = ref("2");
		const override = decideOverride({ read: read(ticket({ blockers: [blocker] }), [{ ref: blocker, open: true }]), force: true });
		expect(override.kind).toBe("startable");
		expect(kinds(override)).toEqual(["blocked"]);
		expect(override.target.blocked).toBe("blocked");
	});

	test("starts a claimed ticket, and carries the check it cleared", () => {
		const override = decideOverride({ read: read(ticket({ claim: { by: "someone" } })), force: true });
		expect(override.kind).toBe("startable");
		expect(kinds(override)).toEqual(["claimed"]);
	});

	test("carries nothing where nothing needed clearing, so the warning is never spurious", () => {
		const override = decideOverride({ read: read(ticket()), force: true });
		expect(kinds(override)).toEqual([]);
	});

	// ADR-0037: the other two are judgments about state somebody else wrote, and closed is the tracker's own
	// canonical statement that there is no work. Reopening it is the repair.
	test("does not reach a closed ticket, and still reports every check that failed", () => {
		const override = decideOverride({ read: read(ticket({ state: "closed", claim: { by: "someone" } })), force: true });
		expect(override.kind).toBe("refused");
		expect(kinds(override)).toEqual(["closed", "claimed"]);
	});
});

describe("clearedByForce", () => {
	test("says which checks --force is allowed past, so one answer decides the refusal and its advice", () => {
		expect(clearedByForce({ kind: "blocked", blockers: [] })).toBe(true);
		expect(clearedByForce({ kind: "claimed", by: null })).toBe(true);
		expect(clearedByForce({ kind: "closed" })).toBe(false);
	});
});
