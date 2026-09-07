/**
 * The stand-in a GitHub recording's hosts are rewritten to. Dot-less on purpose: the identifier guard
 * matches a bare host only when a dotted name is followed by `/` or `:`, and it compares whole tokens,
 * so a dotted synthetic host would cost one allowlist line per distinct URL in every recording stored.
 * ADR-0023 has the reasoning and what to do when a recording still trips the guard.
 */
export const GITHUB_PLACEHOLDER_HOST = "github-test-tree";

// A scheme and everything up to the path: userinfo, host and port together, since all three name a
// system. Run before EMAIL_HOST so a scheme carrying userinfo is consumed whole rather than half.
const SCHEME_AUTHORITY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\/]*/g;

// The scp-form remote and the email, neither of which carries a scheme. The final label has to be
// letters, which is what separates a host from the other thing spelled with an `@`: without it, every
// `package@1.2.3` in a captured lockfile or CLI banner is read as a host.
const EMAIL_HOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A captured exchange with every host replaced by `placeholderHost`, leaving paths intact so a reader can
 * still tell one issue's URL from another's.
 *
 * This closes the shapes a tracker CLI is known to emit. It is not a proof of absence — an encoding it
 * does not recognise passes through — so `scripts/check-identifiers.sh` remains the backstop, and a
 * recording that trips it means extending this rather than adding an allowlist line.
 */
export function redactRecordingIdentifiers(text: string, placeholderHost: string): string {
	return text.replace(SCHEME_AUTHORITY, placeholderHost).replace(EMAIL_HOST, placeholderHost);
}
