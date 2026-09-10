import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyFailure, collapseFailure } from "./failure-class";
import { loadRecording, recordingsDir } from "./recording";

function stderrOf(name: string): string {
	return loadRecording(join(recordingsDir("github"), `${name}.json`)).stderr;
}

describe("classifyFailure", () => {
	test("reads the wording gh actually printed for a host that would not resolve as an outage", () => {
		expect(stderrOf("read-outage")).toMatch(/\S/);
		expect(classifyFailure(stderrOf("read-outage"))).toBe("outage");
	});

	test("reads the wording gh printed for a repository that does not exist as a defect", () => {
		expect(classifyFailure(stderrOf("read-defect"))).toBe("defect");
	});

	// The ported alternation's own cases, kept because nothing captured here exercises them: gh's wording could
	// change to any of these and the classification must hold, and neither shape is reproducible on a test tree.
	test("reads the ported connectivity and server-error wordings as outages", () => {
		expect(classifyFailure("dial tcp: lookup api: no such host")).toBe("outage");
		expect(classifyFailure("Post \"...\": net/http: TLS handshake timeout")).toBe("outage");
		expect(classifyFailure("HTTP 503: Service Unavailable")).toBe("outage");
	});

	test("reads a connection that failed after it was established as an outage", () => {
		// The ported alternatives all name pre-connection failures, so each of these aborted a read that should
		// have flagged an outage and carried on.
		expect(classifyFailure('Post "…/graphql": read tcp: read: connection reset by peer')).toBe("outage");
		expect(classifyFailure('Post "…/graphql": EOF')).toBe("outage");
		expect(classifyFailure('Post "…": context deadline exceeded (Client.Timeout exceeded while awaiting headers)')).toBe(
			"outage",
		);
	});

	test("reads being told to slow down as an outage, and a refusal of access as a defect", () => {
		expect(classifyFailure("HTTP 403: You have exceeded a secondary rate limit")).toBe("outage");
		expect(classifyFailure("HTTP 403: Resource not accessible by integration")).toBe("defect");
	});

	test("reads a repository or field merely named eof as a defect, not as a truncated response", () => {
		// The transport wording is `…: EOF`; a bare word boundary matched a GraphQL message about a request that
		// is wrong, and degrading one of those silently is what the fall-through direction exists to prevent.
		expect(classifyFailure("GraphQL: Could not resolve to a Repository with the name 'acme/eof-parser'. (repository)")).toBe(
			"defect",
		);
		expect(classifyFailure("GraphQL: Field 'eof' doesn't exist on type 'Issue'")).toBe("defect");
	});

	test("reads a 4xx as a defect, so a request that is wrong is not retried as weather", () => {
		expect(classifyFailure("HTTP 422: Validation Failed")).toBe("defect");
	});

	test("reads a failure it cannot place as a defect, never as an outage", () => {
		expect(classifyFailure("")).toBe("defect");
		expect(classifyFailure("something nobody has seen before")).toBe("defect");
	});
});

describe("collapseFailure", () => {
	test("turns the several lines gh really printed into one", () => {
		const collapsed = collapseFailure(stderrOf("claim-outage"));
		expect(stderrOf("claim-outage")).toContain("\n");
		expect(collapsed).not.toContain("\n");
		expect(collapsed).toBe("error connecting to nextup-outage.invalid check your internet connection or github-test-tree");
	});

	test("leaves nothing at either end, so a message never reads as ending early", () => {
		expect(collapseFailure("  padded  ")).toBe("padded");
		expect(collapseFailure("\n\n")).toBe("");
	});

	test("collapses a tab and a carriage return too, which a CLI on another platform will send", () => {
		expect(collapseFailure("one\r\ntwo\tthree")).toBe("one two three");
	});
});
