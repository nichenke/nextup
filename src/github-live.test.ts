import { describe, expect, test } from "bun:test";
import { GitHubLiveError, githubLiveTracker } from "./github-live";
import type { Runner } from "./runner";
import { GITHUB_TEST_TREE, openIssues } from "./test-tree";
import { fakeRunner, githubRecording, replayRunner } from "./test-support";

/** The limit whose over-fetched row makes the adapter ask for exactly the rows the stored captures were taken at. */
const WHOLE_TREE = openIssues(GITHUB_TEST_TREE).length;

function tracker(runner: Runner, repo = GITHUB_TEST_TREE.repo) {
	return githubLiveTracker({ runner, repo });
}

describe("readBlind", () => {
	/**
	 * Answered by the stored capture of the projection-less read, matched on argv. The match is the assertion:
	 * `replayRunner` refuses a call it has no recording for, so this passes only if the projection really was
	 * narrowed on the way out.
	 */
	const blind = replayRunner([githubRecording("ticket-set-without-blockers")]);

	test("asks the narrowed projection, and reads every blocking field as unknown", () => {
		const read = tracker(blind).readBlind(WHOLE_TREE);
		expect(read.tickets.length).toBe(WHOLE_TREE);
		expect(read.tickets.every((ticket) => ticket.blockers === "unknown")).toBe(true);
	});

	test("reports the whole set as unreadable rather than as having no blockers", () => {
		const read = tracker(blind).readBlind(WHOLE_TREE);
		expect(read.degraded).toEqual([{ kind: "unreadable-blocking", tickets: WHOLE_TREE, of: WHOLE_TREE }]);
	});

	test("refuses a call whose projection it cannot find, rather than passing it through unnarrowed", () => {
		const unreachable: Runner = () => {
			throw new Error("the read was passed through without its projection being narrowed");
		};
		expect(() => tracker(unreachable).readBlind(WHOLE_TREE)).toThrow(/projection/);
	});
});

describe("read", () => {
	test("goes through the adapter unchanged", () => {
		const read = tracker(replayRunner([githubRecording("ticket-set")])).read(WHOLE_TREE);
		expect(read.tickets.length).toBe(WHOLE_TREE);
		expect(read.tickets.some((ticket) => ticket.blockers !== "unknown")).toBe(true);
	});
});

describe("observe", () => {
	function observing(result: { code: number; stdout: string; stderr?: string }) {
		return () => tracker(fakeRunner({ code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" })).observe();
	}

	test("throws rather than degrading when the independent read fails", () => {
		expect(observing({ code: 1, stdout: "", stderr: "could not resolve host" })).toThrow(GitHubLiveError);
		expect(observing({ code: 1, stdout: "", stderr: "could not resolve host" })).toThrow(/exit 1/);
	});

	test("throws on a response that is not JSON", () => {
		expect(observing({ code: 0, stdout: "not json" })).toThrow(/returned no JSON/);
	});

	test("throws on a response that is not a list of pages", () => {
		expect(observing({ code: 0, stdout: "{}" })).toThrow(/where pages were asked for/);
	});

	test("throws on a page that is not a list", () => {
		expect(observing({ code: 0, stdout: "[{}]" })).toThrow(/page 0 is not a list/);
	});

	test("throws on a row it cannot read, rather than reporting a ticket it half understood", () => {
		expect(observing({ code: 0, stdout: "[[{}]]" })).toThrow(/number is not a whole number/);
	});

	test("drops a pull request before parsing it, since the adapter's own read never sees one", () => {
		expect(observing({ code: 0, stdout: '[[{"pull_request": {}}]]' })()).toEqual([]);
	});
});
