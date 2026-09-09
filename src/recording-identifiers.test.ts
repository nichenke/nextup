import { describe, expect, test } from "bun:test";
import { runGuardOn } from "../scripts/guard-harness";
import { GITHUB_PLACEHOLDER_HOST, redactRecordingIdentifiers } from "./recording-identifiers";

const redact = (text: string): string => redactRecordingIdentifiers(text, GITHUB_PLACEHOLDER_HOST);

// Each of these must be the last thing on its line, with nothing after it but the closing quote and the
// semicolon. The guard breaks tokens on whitespace and strips one run of trailing punctuation, so a URL
// followed by anything else — a second constant, a trailing comment — becomes one long token that matches no
// allowlist entry. Ending the line is necessary and not sufficient; what follows has to be strippable.
const ISSUE_URL = "https://example.com/example/repo/issues/1";
const SSH_URL = "ssh://git@example.com/example/repo.git";
const USERINFO_URL = "https://alice@example.com/group/project/-/issues/1";
const SCP_REMOTE = "git@example.com:example/repo.git";
const QUERY_URL = "https://example.com/?next=/group/project/-/issues/1";
const BARE_HOST_PATH = "example.com/group/project/-/issues/1";
const USERLESS_SCP = "example.com:example/repo.git";
const HOST_PORT = "example.com:8443";
const HOST = GITHUB_PLACEHOLDER_HOST;

// Split the way `scripts/check-identifiers.test.ts` splits its fixtures: these two carry the very shape the
// guard flags, and the guard reads this file, so spelling either one whole fails the build it belongs to.
const SOURCE_REF = "src/test-tree" + ".ts:27";
const LOCKFILE_REF = "bun" + ".lockb:1";
const QUERY_AT_HOST = "https:" + "//example.com?next=/a/b";
const FRAGMENT_AT_HOST = "https:" + "//example.com#section";

describe("redactRecordingIdentifiers", () => {
	test("replaces a scheme and host with the placeholder, keeping the path", () => {
		expect(redact(ISSUE_URL)).toBe(`${HOST}/example/repo/issues/1`);
	});

	test("replaces a host reached over a non-http scheme", () => {
		expect(redact(SSH_URL)).toBe(`${HOST}/example/repo.git`);
	});

	// A query or fragment can follow the host with no `/` between them, and swallowing it would drop part of
	// what the recording said rather than only the host.
	test("keeps a query or fragment that follows the host directly", () => {
		expect(redact(QUERY_AT_HOST)).toBe(`${HOST}?next=/a/b`);
		expect(redact(FRAGMENT_AT_HOST)).toBe(`${HOST}#section`);
	});

	test("replaces a host carrying userinfo", () => {
		expect(redact(USERINFO_URL)).toBe(`${HOST}/group/project/-/issues/1`);
	});

	test("replaces the scp-form remote, which carries no scheme to match on", () => {
		expect(redact(SCP_REMOTE)).toBe(`${HOST}:example/repo.git`);
	});

	// The guard flags a dotted host before a `/` or a `:` with no scheme and no user at all. Redaction that
	// covered only the scheme and `user@host` forms left these three to the guard, which fails the build
	// rather than fixing the recording.
	test("replaces a host carrying neither a scheme nor a user", () => {
		expect(redact(BARE_HOST_PATH)).toBe(`${HOST}/group/project/-/issues/1`);
		expect(redact(USERLESS_SCP)).toBe(`${HOST}:example/repo.git`);
		expect(redact(HOST_PORT)).toBe(`${HOST}:8443`);
	});

	test("leaves a dotted version string alone, which has the same shape as a host", () => {
		expect(redact("bun 1.4.0/darwin")).toBe("bun 1.4.0/darwin");
		expect(redact("v2.100.0:release")).toBe("v2.100.0:release");
	});

	// Accepted loss, pinned rather than fixed: guard parity means a path ending in a short letters-only
	// extension before a separator is rewritten too. The guard flags these shapes whatever redaction does,
	// so the alternative is not a faithful recording but a failed build.
	test("rewrites a file reference that has a host's shape, which parity with the guard costs", () => {
		expect(redact(SOURCE_REF)).toBe(`src/${HOST}:27`);
		expect(redact(LOCKFILE_REF)).toBe(`${HOST}:1`);
	});

	test("leaves a file reference alone when no separator follows it", () => {
		expect(redact(`see ${SOURCE_REF.replace(":27", "")} for the spec`)).toBe(
			`see ${SOURCE_REF.replace(":27", "")} for the spec`,
		);
	});

	// The guard admits an empty label after the `@`, so redaction has to as well; a stricter rule here left
	// this shape for the guard to fail the build on.
	test("replaces a degenerate host whose first label is empty", () => {
		expect(redact("user@" + ".com")).toBe(HOST);
	});

	// A JSON escape's letter is a legal first character for a scheme, a host and an email local part alike, so
	// a rule that begins matching there swallows it and leaves a lone backslash — which stops the recording
	// being JSON at all, silently, with the guard reporting nothing wrong.
	test("leaves a recording parseable when a host follows a JSON escape", () => {
		for (const tail of [ISSUE_URL, BARE_HOST_PATH, "user@example" + ".com"]) {
			const redacted = redact(JSON.stringify({ body: `first\n${tail}` }));
			expect(() => JSON.parse(redacted)).not.toThrow();
			expect((JSON.parse(redacted) as { body: string }).body.startsWith("first\n")).toBe(true);
		}
	});

	// A lookbehind stops a match beginning at the escape's own letter but not one beginning a character later,
	// so a literal `\\` before a host ate the host's first character and glued the rest to the backslash.
	test("keeps every escape intact when a host follows it directly", () => {
		for (const prefix of ["first\n", "tab\t", "back\\", "ret\r"]) {
			const redacted = redact(JSON.stringify({ body: prefix + BARE_HOST_PATH }));
			expect(() => JSON.parse(redacted)).not.toThrow();
			expect((JSON.parse(redacted) as { body: string }).body).toBe(`${prefix}${HOST}/group/project/-/issues/1`);
		}
	});

	// JSON encodes a literal backslash as two, so the second one plus the following slash look exactly like
	// JSON's optional `\/` escape. Unescaping unconditionally ate the real backslash and changed content that
	// has nothing to do with any host.
	test("preserves a literal backslash that precedes a slash", () => {
		const redacted = redact(JSON.stringify({ body: "a\\/b" }));
		expect(() => JSON.parse(redacted)).not.toThrow();
		expect((JSON.parse(redacted) as { body: string }).body).toBe("a\\/b");
	});

	test("leaves a package version alone, which is the other thing spelled with an @", () => {
		expect(redact("typescript@5.1.2")).toBe("typescript@5.1.2");
		expect(redact("@types/bun@1.4.0")).toBe("@types/bun@1.4.0");
	});

	test("replaces every host in one blob, which is what a recording holds", () => {
		const blob = `{"url":"${ISSUE_URL}","ssh_url":"${SCP_REMOTE}"}`;
		expect(redact(blob)).toBe(`{"url":"${HOST}/example/repo/issues/1","ssh_url":"${HOST}:example/repo.git"}`);
	});

	test("leaves an already-redacted recording unchanged, so a re-capture is stable", () => {
		const once = redact(ISSUE_URL);
		expect(redact(once)).toBe(once);
	});

	// Asserted against the real bash guard rather than a TypeScript copy of its pattern — ADR-0024 has why.
	// Scoped to hosts on purpose: the guard's fourth shape, a slug and a `#` before digits, carries no host,
	// so no rule here reaches it and this corpus deliberately holds none. ADR-0024 covers that gap.
	test("leaves behind no host the real identifier guard matches", () => {
		const corpus = [
			ISSUE_URL,
			SSH_URL,
			USERINFO_URL,
			SCP_REMOTE,
			QUERY_URL,
			BARE_HOST_PATH,
			USERLESS_SCP,
			HOST_PORT,
			QUERY_AT_HOST,
			FRAGMENT_AT_HOST,
			"https:" + "\\/\\/internal.corp" + ".test\\/group\\/x",
			"user@" + ".internal.corp" + ".test/p",
			"mirror.internal.test" + "/team/app:1.2.3",
		].join("\n");

		const result = runGuardOn(`${redact(corpus)}\n`);
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test("refuses to vouch for itself: the guard rejects the same corpus unredacted", () => {
		const result = runGuardOn(`${"https:" + "//internal.corp" + ".test/x"}\n`);
		expect(result.exitCode).not.toBe(0);
	});
});
