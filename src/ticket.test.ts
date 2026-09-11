import { describe, expect, test } from "bun:test";
import { ticketId } from "./ticket";
import { GITHUB_HOST, type TicketRef, githubTicketRef, gitlabTicketRef, jiraTicketRef, resolveTicketRef } from "./ticket-ref";
import { routedRunner } from "./test-support";

const gitlab = (over: { repo?: string; host?: string | null; key?: string } = {}): TicketRef =>
	gitlabTicketRef(over.repo ?? "example/repo", over.host === undefined ? "example.com" : over.host, over.key ?? "1");

// Each of these pairs shared one node before the host became part of the identity, so a later seed
// overwrote the other's openness — which decides whether a dependent reads blocked or unblocked.
describe("ticketId tells distinct tickets apart", () => {
	test("the same repo and number on two hosts are two tickets", () => {
		expect(ticketId(gitlab({ host: "example.com" }))).not.toBe(ticketId(gitlab({ host: "other-host.test" })));
	});

	test("two Jira tenants sharing a key are two tickets", () => {
		expect(ticketId(jiraTicketRef("example.com", "TEST-42"))).not.toBe(ticketId(jiraTicketRef("other-host.test", "TEST-42")));
	});

	test("two projects numbering from one are two tickets", () => {
		expect(ticketId(githubTicketRef("example/one", "1"))).not.toBe(ticketId(githubTicketRef("example/two", "1")));
	});

	test("the same ticket resolves to the same id", () => {
		expect(ticketId(gitlab())).toBe(ticketId(gitlab()));
	});

	// A GitLab short form has no host and a pasted URL does, so the two are deliberately distinct nodes. The
	// GitHub variant is the one where this no longer arises, which the merges below are about.
	test("a ref that knows its host is distinct from one that does not", () => {
		expect(ticketId(gitlab({ host: "example.com" }))).not.toBe(ticketId(gitlab({ host: null })));
	});

	// Joining the parts with a delimiter was not injective: a colon inside the repo could stand in for the
	// separator before the host, so these two distinct refs shared one graph node and the later seed
	// overwrote the earlier's openness — a real open blocker read as closed.
	test("a delimiter inside a repo path cannot impersonate the host separator", () => {
		expect(ticketId(gitlab({ repo: "a:b/c/d", host: null }))).not.toBe(ticketId(gitlab({ repo: "b/c/d", host: "a" })));
	});

	test("a host carrying a port is distinct from the same host without one", () => {
		expect(ticketId(gitlab({ host: "example.com:8443" }))).not.toBe(ticketId(gitlab({ host: "example.com" })));
	});
});

// The three axes ADR-0038's Consequences name. Each one used to give a GitHub ticket a second graph key
// depending on how its reference was obtained, and each is closed by the GitHub variant's own shape rather
// than by a comparison somewhere downstream.
describe("ticketId is one key per GitHub ticket, however the reference was obtained", () => {
	const ADAPTER = githubTicketRef("example/repo", "1");
	const NO_GIT = routedRunner({});

	// Joined rather than spelled whole: the identifier guard reads a literal URL as an identifier, and
	// `CLAUDE.md` has the rule.
	test("a pasted URL and an adapter row agree, though only one of them saw a host", () => {
		const pasted = ["https:/", GITHUB_HOST, "example", "repo", "issues", "1"].join("/");
		expect(ticketId(resolveTicketRef(pasted, { runner: NO_GIT }))).toBe(ticketId(ADAPTER));
	});

	test("a repository path spelled in another case is the same ticket", () => {
		expect(ticketId(githubTicketRef("Example/Repo", "1"))).toBe(ticketId(ADAPTER));
	});

	test("a padded key cannot be built, so it cannot be a second key", () => {
		expect(() => githubTicketRef("example/repo", "01")).toThrow("not a canonical issue number");
	});
});
