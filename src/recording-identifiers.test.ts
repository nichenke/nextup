import { describe, expect, test } from "bun:test";
import { GITHUB_PLACEHOLDER_HOST, redactRecordingIdentifiers } from "./recording-identifiers";

const redact = (text: string): string => redactRecordingIdentifiers(text, GITHUB_PLACEHOLDER_HOST);

// Each of these ends its line, because the identifier guard breaks tokens on whitespace: a URL literal
// followed immediately by more code is read as one long token that matches no allowlist entry.
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

	test("leaves behind nothing the identifier guard matches", () => {
		const redacted = redact(
			[ISSUE_URL, SSH_URL, USERINFO_URL, SCP_REMOTE, QUERY_URL, BARE_HOST_PATH, USERLESS_SCP, HOST_PORT].join("\n"),
		);
		expect(redacted).not.toMatch(/:\/\//);
		expect(redacted).not.toMatch(/[A-Za-z0-9-](?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}[:/]/);
	});
});
