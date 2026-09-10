import { describe, expect, test } from "bun:test";
import { githubClaimCommand, githubIssueListCommand, originRemoteCommand, worktreeAddCommand } from "./command-builders";
import { NotAReadError, readOnlyRunner } from "./read-only-runner";
import { fakeRunner } from "./test-support";

const answered = { code: 0, stdout: "answered", stderr: "" };

function guarded(): { run: ReturnType<typeof readOnlyRunner>; issued: string[][] } {
	const issued: string[][] = [];
	const run = readOnlyRunner((argv) => {
		issued.push([...argv]);
		return answered;
	});
	return { run, issued };
}

describe("readOnlyRunner", () => {
	test("passes the ticket-set read through", () => {
		const { run, issued } = guarded();
		const argv = [...githubIssueListCommand({ repo: "nichenke/nextup", rows: 8 })];
		expect(run(argv)).toEqual(answered);
		expect(issued).toEqual([argv]);
	});

	test("passes a plain gh api request through", () => {
		const { run, issued } = guarded();
		const argv = ["gh", "api", "--paginate", "repos/nichenke/nextup/issues?state=open"];
		expect(run(argv)).toEqual(answered);
		expect(issued).toEqual([argv]);
	});

	test("passes the origin remote read through, since the repository is resolved from it", () => {
		const { run } = guarded();
		expect(run([...originRemoteCommand()])).toEqual(answered);
	});

	test("refuses the claim, which is the write this harness must never issue", () => {
		const { run, issued } = guarded();
		expect(() => run([...githubClaimCommand({ repo: "nichenke/nextup", key: "26" })])).toThrow(NotAReadError);
		expect(issued).toEqual([]);
	});

	test("refuses a git command that would write to a worktree", () => {
		const { run } = guarded();
		expect(() => run([...worktreeAddCommand("/repo", "/repo/.worktrees/x", "feature/x", true)])).toThrow(NotAReadError);
	});

	test("passes the two flags a read here needs", () => {
		const { run } = guarded();
		expect(run(["gh", "api", "--paginate", "--slurp", "repos/nichenke/nextup/issues?state=open"])).toEqual(answered);
	});

	/** Separated, `=`-attached, and the two spellings a per-flag match let through: attached shorthand and a cluster. */
	test.each([
		["-X", ["gh", "api", "-X", "POST", "repos/nichenke/nextup/issues/26/dependencies/blocked_by"]],
		["--method", ["gh", "api", "--method", "DELETE", "repos/nichenke/nextup/issues/26"]],
		["--method=", ["gh", "api", "--method=PATCH", "repos/nichenke/nextup/issues/26"]],
		["-f", ["gh", "api", "graphql", "-f", "query=mutation{}"]],
		["--field", ["gh", "api", "repos/nichenke/nextup/issues", "--field", "title=x"]],
		["-F", ["gh", "api", "repos/nichenke/nextup/issues", "-F", "issue_id=1"]],
		["--raw-field=", ["gh", "api", "repos/nichenke/nextup/issues", "--raw-field=title=x"]],
		["--input", ["gh", "api", "repos/nichenke/nextup/issues", "--input", "-"]],
		["-XPOST", ["gh", "api", "-XPOST", "repos/nichenke/nextup/issues/26/comments"]],
		["-fbody=x", ["gh", "api", "repos/nichenke/nextup/issues/26/comments", "-fbody=x"]],
		["-Fissue_id=1", ["gh", "api", "repos/nichenke/nextup/issues/26/dependencies/blocked_by", "-Fissue_id=1"]],
		["-iXPOST", ["gh", "api", "-iXPOST", "repos/nichenke/nextup/issues/26/comments"]],
	])("refuses a gh api request carrying %s, which makes it a write", (_flag, argv) => {
		const { run, issued } = guarded();
		expect(() => run(argv)).toThrow(NotAReadError);
		expect(issued).toEqual([]);
	});

	test("refuses a flag nobody anticipated, rather than admitting whatever is not on a list of writes", () => {
		const { run } = guarded();
		expect(() => run(["gh", "api", "--some-future-flag", "repos/nichenke/nextup/issues"])).toThrow(NotAReadError);
	});

	test("names the whole command it refused, so a caller can see which call it was", () => {
		const { run } = guarded();
		expect(() => run(["gh", "issue", "edit", "--repo", "nichenke/nextup", "--add-assignee", "@me", "--", "26"])).toThrow(
			/gh issue edit/,
		);
	});

	test("reads the program's final path segment, so an absolute path is judged the same way", () => {
		const { run } = guarded();
		expect(run(["/opt/homebrew/bin/gh", "api", "rate_limit"])).toEqual(answered);
		expect(() => run(["/opt/homebrew/bin/gh", "issue", "close", "26"])).toThrow(NotAReadError);
	});

	test("refuses an empty command rather than passing it on", () => {
		const { run } = guarded();
		expect(() => run([])).toThrow(NotAReadError);
	});

	test("refuses a command whose leading words merely begin with a read's", () => {
		const { run } = guarded();
		expect(() => run(["ghost", "api", "rate_limit"])).toThrow(NotAReadError);
	});

	test("does not swallow what the wrapped runner returned", () => {
		const run = readOnlyRunner(fakeRunner({ code: 4, stdout: "out", stderr: "err" }));
		expect(run(["gh", "api", "rate_limit"])).toEqual({ code: 4, stdout: "out", stderr: "err" });
	});
});
