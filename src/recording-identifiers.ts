/**
 * The stand-in a GitHub recording's hosts are rewritten to. Keep it dot-less: a dotted host would put the
 * recording itself on the identifier allowlist, and ADR-0024 has why such an entry accepts whatever else
 * shares its line.
 */
export const GITHUB_PLACEHOLDER_HOST = "github-test-tree";

// A JSON escape, matched only so it can be handed back untouched. It leads the alternation below because
// consuming `\x` is the only thing that stops a host rule matching *inside* an escape: `n`, `r` and `t` are
// legal first characters for a scheme, a host and an email local part alike. A lookbehind was tried here and
// is not enough — it refuses a match starting at the escape's own letter, but not one starting a character
// later, so a literal `\\` before a host still ate the host's first letter and glued the rest to the
// backslash. Corrupt rather than leaked, and invisible: the guard passes on the result.
const JSON_ESCAPE = /\\u[0-9a-fA-F]{4}|\\[\s\S]/;

// The three host shapes the guard matches, in the order they must be tried. Each would mangle what a later
// one leaves: a scheme carrying userinfo has to be taken whole rather than split at its `@`, and a host
// inside a scheme has to be consumed before the schemeless rule sees it, or that rule leaves the scheme
// standing in front of the placeholder and the result trips the guard it was meant to satisfy.
//
// A scheme and everything up to the path: userinfo, host and port together, since all three name a system.
// `?` and `#` end the authority as surely as `/` does. Without them in the excluded class, a query or
// fragment sitting directly against the host is swallowed with it, so the recording loses what it said and
// not merely where it said it.
const SCHEME_AUTHORITY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\/?#]*/;

// The scp-form remote and the email, neither of which carries a scheme. A dot followed by two letters has to
// appear somewhere after the `@`, which is what keeps an ordinary `package@1.2.3` out — not a claim about the
// final label, since the pattern is unanchored and matches through the letters of a pre-release version.
// Spelled exactly as the guard spells it, including the `*` that admits an empty label, because parity is the
// point; `scripts/check-identifiers.sh` says why it accepts that noise rather than tightening.
const EMAIL_HOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*\.[A-Za-z]{2,}/;

// A dotted host with no scheme and no user, spelled to match the guard's schemeless shape rather than a
// tidier subset — ADR-0024 has why parity is the design and what it costs. Runs last, so the two rules
// above have already consumed the hosts carrying a scheme or a user.
//
// A lookahead for the separator rather than consuming it: the guard's shape swallows the rest of the line,
// and copying that here would destroy the path this function promises to keep.
const BARE_HOST = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[:/])/;

// JSON's optional `\/` escape, and only that. The lookbehind is what separates it from a *literal* backslash
// that happens to precede a slash: JSON writes such a backslash as two, so the second one plus the slash are
// byte-identical to the escape. Replacing unconditionally turned content `a\/b` into `a/b`, corrupting text
// that has nothing to do with a host.
const ESCAPED_SLASH = /(?<!\\)\\\//g;

const REDACTABLE = new RegExp(
	[JSON_ESCAPE, SCHEME_AUTHORITY, EMAIL_HOST, BARE_HOST].map((rule) => rule.source).join("|"),
	"g",
);

/**
 * A captured exchange with each host the identifier guard would flag replaced by `placeholderHost`, leaving
 * paths intact so a reader can still tell one issue's URL from another's. The scheme goes with the host, so
 * the result is not a parseable URL — ADR-0024 says why that is the intent.
 *
 * Not a proof of absence: `scripts/check-identifiers.sh` stays the backstop, and a recording that trips
 * it means extending this rather than adding an allowlist line — ADR-0024.
 */
export function redactRecordingIdentifiers(text: string, placeholderHost: string): string {
	// Unescaping `\/` first, because the guard's own normalization does it first: a URL whose slashes are
	// backslash-escaped carries no literal `://`, so every rule would miss it while the guard — which
	// unescapes before matching — still flags the host, leaving a real host stored verbatim. Safe to rewrite,
	// because a JSON `\/` and a `/` denote the same character. The guard's other normalization, turning `\n`
	// into a real newline, is deliberately not copied: that would break the JSON a recording is made of, which
	// is why escapes are stepped over below rather than resolved.
	return text
		.replace(ESCAPED_SLASH, "/")
		.replace(REDACTABLE, (match) => (match.startsWith("\\") ? match : placeholderHost));
}
