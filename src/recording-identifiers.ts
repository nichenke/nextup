/**
 * The stand-in a GitHub recording's hosts are rewritten to. Keep it dot-less: a dotted host would put the
 * recording itself on the identifier allowlist, and ADR-0024 has why such an entry accepts whatever else
 * shares its line.
 */
export const GITHUB_PLACEHOLDER_HOST = "github-test-tree";

// One rule per host shape the guard matches, applied in the order they are declared. Each consumes what
// the next would otherwise mangle: a scheme carrying userinfo has to be taken whole rather than split at
// its `@`, and a host inside a scheme has to be gone before the schemeless rule runs, or that rule leaves
// the scheme standing in front of the placeholder and the result trips the guard it was meant to satisfy.
//
// A scheme and everything up to the path: userinfo, host and port together, since all three name a system.
// `?` and `#` end the authority as surely as `/` does. Without them in the excluded class, a query or
// fragment sitting directly against the host is swallowed with it, so the recording loses what it said and
// not merely where it said it.
const SCHEME_AUTHORITY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\/?#]*/g;

// The scp-form remote and the email, neither of which carries a scheme. A dot followed by two letters has
// to appear somewhere after the `@`, which is what keeps an ordinary `package@1.2.3` out. It is not a claim
// about the final label: the pattern is unanchored, so a pre-release version such as `1.2.rc3` reached
// through an `@` matches through the `rc` and leaves the `3` behind. The guard's own pattern is unanchored
// the same way and matches the same token, so parity holds — see `scripts/check-identifiers.sh` on why it
// accepts that noise rather than tightening.
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
