/**
 * The stand-in a GitHub recording's hosts are rewritten to. Keep it dot-less: a dotted host would cost an
 * allowlist line per distinct URL in every recording stored. ADR-0024 has why.
 */
export const GITHUB_PLACEHOLDER_HOST = "github-test-tree";

// A scheme and everything up to the path: userinfo, host and port together, since all three name a
// system. Run before EMAIL_HOST so a scheme carrying userinfo is consumed whole rather than half.
const SCHEME_AUTHORITY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\/]*/g;

// The scp-form remote and the email, neither of which carries a scheme. The final label has to be
// letters, or every `package@1.2.3` is read as a host — `scripts/check-identifiers.sh` has why its own
// pattern carries the same constraint.
const EMAIL_HOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A captured exchange with every host replaced by `placeholderHost`, leaving paths intact so a reader can
 * still tell one issue's URL from another's.
 *
 * Not a proof of absence: `scripts/check-identifiers.sh` stays the backstop, and a recording that trips
 * it means extending this rather than adding an allowlist line — ADR-0024.
 */
export function redactRecordingIdentifiers(text: string, placeholderHost: string): string {
	return text.replace(SCHEME_AUTHORITY, placeholderHost).replace(EMAIL_HOST, placeholderHost);
}
