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

// A dotted host with no scheme and no user, kept deliberately identical to the guard's own schemeless
// shape: a trailing `/` or `:` and a letters-only final label. Matching what the guard matches is the
// point — a narrower rule leaves a token that fails the build instead of being redacted, and a wider one
// rewrites text the guard would have accepted. It runs last, so the two rules above have already consumed
// the hosts that carry a scheme or a user.
//
// The shared final-label rule is also what keeps a dotted version out of it: `1.4.0/` and `2.100.0:` end
// in digits. The residual over-match is a path segment ending in a short letters-only extension followed
// by a separator, which would be rewritten inside a fixture rather than reported.
const BARE_HOST = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[:/])/g;

/**
 * A captured exchange with each host the identifier guard would flag replaced by `placeholderHost`, leaving
 * paths intact so a reader can still tell one issue's URL from another's.
 *
 * Not a proof of absence: `scripts/check-identifiers.sh` stays the backstop, and a recording that trips
 * it means extending this rather than adding an allowlist line — ADR-0024.
 */
export function redactRecordingIdentifiers(text: string, placeholderHost: string): string {
	return text
		.replace(SCHEME_AUTHORITY, placeholderHost)
		.replace(EMAIL_HOST, placeholderHost)
		.replace(BARE_HOST, placeholderHost);
}
