import { describe, expect, test } from "bun:test";
import { ticketId } from "./ticket";
import type { TicketRef } from "./ticket-ref";

const ref = (over: Partial<TicketRef>): TicketRef => ({
	tracker: "github",
	repo: "example/repo",
	host: null,
	key: "1",
	...over,
});

// Each of these pairs shared one node before the host became part of the identity, so a later seed
// overwrote the other's openness — which decides whether a dependent reads blocked or unblocked.
describe("ticketId", () => {
	test("the same repo and number on two hosts are two tickets", () => {
		expect(ticketId(ref({ host: "example.com" }))).not.toBe(ticketId(ref({ host: "other-host.test" })));
	});

	test("two Jira tenants sharing a key are two tickets", () => {
		const jira = { tracker: "jira" as const, repo: null, key: "TEST-42" };
		expect(ticketId({ ...jira, host: "example.com" })).not.toBe(
			ticketId({ ...jira, host: "other-host.test" }),
		);
	});

	test("two projects numbering from one are two tickets", () => {
		expect(ticketId(ref({ repo: "example/one" }))).not.toBe(ticketId(ref({ repo: "example/two" })));
	});

	test("the same ticket resolves to the same id", () => {
		expect(ticketId(ref({ host: "example.com" }))).toBe(ticketId(ref({ host: "example.com" })));
	});

	// A short form has no host and a pasted URL does, so the two are deliberately distinct nodes — the
	// docstring's constraint that an adapter must emit one consistent form for a set.
	test("a ref that knows its host is distinct from one that does not", () => {
		expect(ticketId(ref({ host: "example.com" }))).not.toBe(ticketId(ref({ host: null })));
	});
});
