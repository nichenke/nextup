import type { Runner } from "./runner";
import { type TestTreeIssue, type TestTreeSpec, TestTreeError, validateTestTree } from "./test-tree";

/**
 * High enough that the tree never fills it, so a full page is evidence of truncation rather than of a
 * large tree. `gh issue list` defaults to 30 and truncates silently, which here would read as "the issue
 * does not exist" and create a second copy of it.
 */
const LIST_LIMIT = 200;

/**
 * The two states `gh issue list --json state` reports. Narrowed rather than left as a string because
 * `state !== "CLOSED"` reads every unrecognised token as open, which would leave a closed issue closed
 * while the report says the tree matches the spec.
 */
type IssueState = "OPEN" | "CLOSED";

interface ExistingIssue {
	readonly number: number;
	readonly title: string;
	readonly state: IssueState;
	readonly assignees: readonly { readonly login: string }[];
}

/** Every branch that reports a change. A union so the producer and the tests cannot drift apart. */
export type TestTreeAction = "created" | "claimed" | "released" | "closed" | "reopened" | `blocked by ${string}`;

/** An empty report means every issue matched. Label definitions are re-asserted each run, unreported. */
export interface TestTreeChange {
	readonly key: string;
	readonly action: TestTreeAction;
}

export interface TestTreeReport {
	readonly changes: readonly TestTreeChange[];
}

/**
 * Brings the test tree to the state `spec` describes, and reports what it changed. Idempotent; ADR-0023
 * has what it reconciles and why it reconciles nothing else.
 *
 * @throws TestTreeError on any failing call. There is no degraded mode: every step is a precondition for
 * the next, so continuing past a failure would report a tree that does not exist.
 */
export function provisionTestTree(spec: TestTreeSpec, runner: Runner): TestTreeReport {
	validateTestTree(spec);
	const changes: TestTreeChange[] = [];
	try {
		return provision(spec, runner, changes);
	} catch (cause) {
		// Re-thrown carrying what had already been written, so a failure halfway through says which writes
		// landed rather than only which call failed.
		if (cause instanceof TestTreeError) throw new TestTreeError(cause.message, changes);
		throw cause;
	}
}

function provision(spec: TestTreeSpec, runner: Runner, changes: TestTreeChange[]): TestTreeReport {

	for (const label of spec.labels) {
		// `--force` updates rather than failing, and this writes unconditionally and reports no change —
		// ADR-0023 has why a label definition is reconciled when a per-issue label is not.
		run(runner, ["gh", "label", "create", label.name, "--repo", spec.repo, "--color", label.color, "--force"]);
	}

	const existing = listIssues(spec, runner);
	// Title is the identity, so a title renamed by hand in the tracker or edited in the spec is not drift
	// that surfaces later — it reads as absent and gets a second issue created beside the original, which
	// keeps its edges and its claim. A rename is indistinguishable from a deletion from out here, so
	// this is documented in ADR-0023 rather than detected.
	const byTitle = new Map(existing.map((issue) => [issue.title, issue]));
	const numbers = new Map<string, number>();

	for (const issue of spec.issues) {
		const found = byTitle.get(issue.title);
		if (found !== undefined) {
			numbers.set(issue.key, found.number);
			continue;
		}
		numbers.set(issue.key, createIssue(spec, issue, runner));
		changes.push({ key: issue.key, action: "created" });
	}

	for (const issue of spec.issues) {
		const number = numberOf(numbers, issue.key);
		const present = blockedBy(spec, number, runner);
		// Read for every issue, including the ones the spec gives no blockers. Skipping those saved nine calls
		// and made an undeclared edge invisible — and an undeclared edge is not merely untidy, because its
		// reverse direction makes the declared edge un-writable: GitHub refuses an edge whose direct reverse
		// exists, so once the declared one is lost every later run throws on the same write and nothing here
		// can report or remove what is blocking it. Refused rather than deleted, per ADR-0023's scope.
		const declared = issue.blockedBy.map((key) => numberOf(numbers, key));
		const undeclared = present.filter((blocker) => !declared.includes(blocker));
		if (undeclared.length > 0) {
			throw new TestTreeError(
				`issue ${number} is blocked by ${undeclared.join(", ")}, which the spec does not declare`,
			);
		}
		for (const blockerKey of issue.blockedBy) {
			const blockerNumber = numberOf(numbers, blockerKey);
			if (present.includes(blockerNumber)) continue;
			// Checked for the same reason `blockedBy` is: `--jq` prints nothing and exits 0 when the field is
			// absent, so an unchecked read POSTs an empty `issue_id` and the 422 that comes back blames the
			// edge rather than the id.
			const id = run(runner, ["gh", "api", `repos/${spec.repo}/issues/${blockerNumber}`, "--jq", ".id"]).trim();
			if (!/^[0-9]+$/.test(id)) {
				throw new TestTreeError(`${JSON.stringify(id)} is not an issue id for ${blockerKey}`);
			}
			run(runner, [
				"gh",
				"api",
				"--method",
				"POST",
				`repos/${spec.repo}/issues/${number}/dependencies/blocked_by`,
				"-F",
				`issue_id=${id}`,
			]);
			changes.push({ key: issue.key, action: `blocked by ${blockerKey}` });
		}
	}

	// This runs after the edge loop for no reason the tracker imposes: GitHub accepts an edge whose target is
	// already closed, measured, so the two loops would work in either order. ADR-0023 records the probe,
	// because an earlier comment here asserted an ordering constraint that does not exist.
	for (const issue of spec.issues) {
		const number = numberOf(numbers, issue.key);
		const found = byTitle.get(issue.title);
		changes.push(...reconcileClaim(spec, issue, number, found, runner));
		changes.push(...reconcileState(spec, issue, number, found, runner));
	}

	return { changes };
}

/**
 * `claimed` means the issue carries an assignee, not that it carries a particular one — which is what the
 * candidate filter reads, and all the tree has to offer it. So any assignee satisfies `claimed: true`,
 * while `claimed: false` removes every one of them; the two branches are asymmetric only if `claimed` is
 * misread as "assigned to us".
 */
function reconcileClaim(
	spec: TestTreeSpec,
	issue: TestTreeIssue,
	number: number,
	found: ExistingIssue | undefined,
	runner: Runner,
): readonly TestTreeChange[] {
	const assigned = found?.assignees.map((assignee) => assignee.login) ?? [];
	if (issue.claimed) {
		if (assigned.length > 0) return [];
		run(runner, ["gh", "issue", "edit", String(number), "--repo", spec.repo, "--add-assignee", "@me"]);
		return [{ key: issue.key, action: "claimed" }];
	}
	return assigned.map((login) => {
		run(runner, ["gh", "issue", "edit", String(number), "--repo", spec.repo, "--remove-assignee", login]);
		return { key: issue.key, action: "released" };
	});
}

function reconcileState(
	spec: TestTreeSpec,
	issue: TestTreeIssue,
	number: number,
	found: ExistingIssue | undefined,
	runner: Runner,
): readonly TestTreeChange[] {
	const closed = found?.state === "CLOSED";
	if (issue.closed === closed) return [];
	run(runner, ["gh", "issue", issue.closed ? "close" : "reopen", String(number), "--repo", spec.repo]);
	return [{ key: issue.key, action: issue.closed ? "closed" : "reopened" }];
}

function listIssues(spec: TestTreeSpec, runner: Runner): readonly ExistingIssue[] {
	const stdout = run(runner, [
		"gh",
		"issue",
		"list",
		"--repo",
		spec.repo,
		"--state",
		"all",
		"--limit",
		String(LIST_LIMIT),
		"--json",
		"number,title,state,assignees",
	]);
	const issues = parseIssues(stdout);
	if (issues.length >= LIST_LIMIT) {
		throw new TestTreeError(`${spec.repo} returned ${LIST_LIMIT} issues, so the listing may be truncated`);
	}
	// `validateTestTree` checks the same property over the spec; the tracker can violate it on its own,
	// through a rename or a spec that once held a duplicate. ADR-0023 has what a stranded issue costs.
	const seen = new Set<string>();
	for (const issue of issues) {
		if (seen.has(issue.title)) {
			throw new TestTreeError(`${spec.repo} has two issues that share the title ${issue.title}`);
		}
		seen.add(issue.title);
	}
	// An issue the spec does not describe, which is what a rename actually leaves behind: the renamed issue
	// and the one provisioning then creates carry different titles, so the collision check above never sees it.
	// The same check catches an issue created by hand and one filed under any title the spec does not use.
	const described = new Set(spec.issues.map((issue) => issue.title));
	for (const issue of issues) {
		if (!described.has(issue.title)) {
			throw new TestTreeError(`${spec.repo} issue ${issue.number} is titled ${issue.title}, which the spec does not describe`);
		}
	}
	return issues;
}

/**
 * Checks the listing field by field instead of asserting a type over it. A cast that skipped this read a
 * missing `title` as "no spec issue exists", which creates a second copy of the whole tree on every run —
 * and the trigger is not the tracker changing but the `--json` field list above and `ExistingIssue`
 * drifting apart in one edit.
 *
 * @throws TestTreeError naming the first field that is absent or the wrong shape.
 */
function parseIssues(stdout: string): readonly ExistingIssue[] {
	// `gh` can exit 0 with stdout that is not JSON at all — empty, or a warning — and an unguarded parse
	// raises a SyntaxError that escapes the TestTreeError this function's caller documents. Its sibling
	// `blockedBy` already guarded the same thing.
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (cause) {
		throw new TestTreeError(
			`the issue listing is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	if (!Array.isArray(parsed)) throw new TestTreeError(`the issue listing is not a list: ${stdout.slice(0, 80)}`);
	return parsed.map((raw, index) => {
		const at = `issue ${index} of the listing`;
		// Before the field checks, not with them: destructuring a null element raises a TypeError that escapes
		// the TestTreeError this promises, while a null *inside* `assignees` is caught below.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new TestTreeError(`${at} is not an object: ${JSON.stringify(raw)}`);
		}
		const { number, title, state, assignees } = raw as Partial<ExistingIssue>;
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
			throw new TestTreeError(`${at} has no usable number: ${JSON.stringify(number)}`);
		}
		if (typeof title !== "string" || title === "") {
			throw new TestTreeError(`${at} has no title: ${JSON.stringify(title)}`);
		}
		if (state !== "OPEN" && state !== "CLOSED") {
			throw new TestTreeError(`${at} reports the unrecognised state ${JSON.stringify(state)}`);
		}
		if (!Array.isArray(assignees) || assignees.some((one) => typeof one?.login !== "string")) {
			throw new TestTreeError(`${at} has no usable assignees: ${JSON.stringify(assignees)}`);
		}
		return { number, title, state, assignees };
	});
}

function createIssue(spec: TestTreeSpec, issue: TestTreeIssue, runner: Runner): number {
	const labels = issue.labels.flatMap((label) => ["--label", label]);
	const stdout = run(runner, [
		"gh",
		"issue",
		"create",
		"--repo",
		spec.repo,
		"--title",
		issue.title,
		"--body",
		issue.body,
		...labels,
	]);
	const number = Number(stdout.trim().split("/").pop());
	if (!Number.isSafeInteger(number) || number <= 0) {
		throw new TestTreeError(`creating ${issue.key} printed no issue number: ${stdout.trim()}`);
	}
	return number;
}

/**
 * The blockers a tracker already records, read from the list endpoint rather than from the summary field —
 * `docs/agents/issue-tracker.md` has why the summary cannot be trusted here.
 */
function blockedBy(spec: TestTreeSpec, number: number, runner: Runner): readonly number[] {
	const stdout = run(runner, [
		"gh",
		"api",
		`repos/${spec.repo}/issues/${number}/dependencies/blocked_by`,
		"--jq",
		"[.[].number]",
	]);
	// Checked rather than cast, matching `parseIssues` above: `present.includes(...)` decides whether an edge
	// exists, and a shape this could not read would report every blocker absent and re-POST all of them.
	// GitHub accepts that, so the symptom is a change report claiming work it did not do.
	const parsed: unknown = JSON.parse(stdout.trim() || "[]");
	const numbers = Array.isArray(parsed) ? parsed : undefined;
	if (numbers === undefined || numbers.some((one) => !Number.isSafeInteger(one) || Number(one) <= 0)) {
		throw new TestTreeError(`the blockers of issue ${number} are not a list of issue numbers: ${stdout.trim()}`);
	}
	return numbers as number[];
}

function numberOf(numbers: ReadonlyMap<string, number>, key: string): number {
	const number = numbers.get(key);
	if (number === undefined) throw new TestTreeError(`${key} has no issue number`);
	return number;
}

function run(runner: Runner, argv: readonly string[]): string {
	const result = runner([...argv]);
	if (result.code !== 0) {
		// Two tokens collapse `create`, `list`, `edit`, `close` and `reopen` into one indistinguishable
		// "gh issue exited 1". Three still collapse every dependency write into "gh api --method", which is the
		// one failure ADR-0023 makes a design point of, so the endpoint carries the rest of the answer.
		const endpoint = argv.find((word) => word.startsWith("repos/"));
		const called = [...argv.slice(0, 3), endpoint].filter((word) => word !== undefined).join(" ");
		throw new TestTreeError(`${called} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return result.stdout;
}
