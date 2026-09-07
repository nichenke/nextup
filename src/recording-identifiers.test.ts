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
const HOST = GITHUB_PLACEHOLDER_HOST;

describe("redactRecordingIdentifiers", () => {
	test("replaces a scheme and host with the placeholder, keeping the path", () => {
		expect(redact(ISSUE_URL)).toBe(`${HOST}/example/repo/issues/1`);
	});

	test("replaces a host reached over a non-http scheme", () => {
		expect(redact(SSH_URL)).toBe(`${HOST}/example/repo.git`);
	});

	test("replaces a host carrying userinfo", () => {
		expect(redact(USERINFO_URL)).toBe(`${HOST}/group/project/-/issues/1`);
	});

	test("replaces the scp-form remote, which carries no scheme to match on", () => {
		expect(redact(SCP_REMOTE)).toBe(`${HOST}:example/repo.git`);
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
		const redacted = redact([ISSUE_URL, SSH_URL, USERINFO_URL, SCP_REMOTE, QUERY_URL].join("\n"));
		expect(redacted).not.toMatch(/:\/\//);
		expect(redacted).not.toMatch(/[A-Za-z0-9-](?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}[:/]/);
	});
});
