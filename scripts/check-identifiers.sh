#!/usr/bin/env bash
# Fails on any identifier-shaped token in a tracked file that is not allowlisted verbatim.
#
# The allowlist holds whole tokens, not hostnames or namespaces. Extracting "just the sensitive
# part" of a URL meant tracking git's URL grammar, and every version of that had a bypass: a
# nested GitLab namespace, an omitted SSH user, a port read as an owner, a native git:// remote
# matched by nothing. Whole-token matching has no grammar to get wrong -- an unrecognised token
# fails whatever shape it takes. A new legitimate identifier costs one line below, which for a
# repo with a handful of them is the point rather than the tax.
#
# Deliberately not a denylist: a denylist of real hosts and project keys would itself be the
# content it guards, so publishing the guard would leak exactly what it protects.
set -euo pipefail

ALLOWED='
https://anthropic.com/claude-code/marketplace.schema.json
https://github.com/nichenke/nextup
https://github.com/nichenke/nextup/issues/2
https://github.com/nichenke/nextup/issues?q=is%3Aissue+label%3Aready-for-agent
https://registry.npmjs.org
https://example.com/issues/1
TEST-42
'

# Anything that can carry an identity: a scheme of any kind, an @ followed by a real host (an
# email or an scp-form remote), a cross-repo issue reference, or a project-key shape. Broad on
# purpose -- a false positive costs one allowlist line, a false negative is a leak.
#
# The @ form requires a dotted host with a letters-only final label. Without that it matched
# every `package@version` in the lockfile and every pinned action version, which is noise no
# reviewer would read.
PATTERN='([a-z][a-z0-9+.-]*://[^[:space:]]+)|([A-Za-z0-9._%+/-]+@[A-Za-z0-9.-]*\.[A-Za-z]{2,}([:/][^[:space:]]*)?)|([A-Za-z0-9._/-]+#[0-9]+)|([A-Z]{2,10}-[0-9]+)'

# A source literal can hold several identifiers separated by escape sequences, which give grep no
# whitespace to break on. Turning those escapes into real newlines splits the tokens apart.
# Truncating at the first escape instead -- which is what this did originally -- silently
# discarded everything after it, so a second URL hidden behind a `\n` passed unchecked.
normalized=$(git ls-files -z | xargs -0 grep -Ih '' 2>/dev/null |
	awk '{ gsub(/\\[nrt]/, "\n"); print }' || true)

# Surrounding markup travels with a token: a markdown link wraps it in parentheses, prose ends it
# with a full stop, and a source-code string literal closes with a quote, sometimes escaped. None
# of that is part of the identifier.
#
# `]` leads the trailing class because a bracket expression cannot escape it -- written as `\]`
# further in, it closes the class instead, and trailing punctuation was silently never stripped.
tokens=$(printf '%s\n' "$normalized" | grep -oE "$PATTERN" |
	sed -E 's#^[[({<"'"'"'`]+##; s#[].,;:!?)}>"'"'"'`\\]+$##' | sort -u || true)

failed=0
while IFS= read -r token; do
	[ -n "$token" ] || continue
	if ! printf '%s\n' "$ALLOWED" | grep -qxF "$token"; then
		printf 'unrecognised identifier: %s\n' "$token" >&2
		failed=1
	fi
done <<<"$tokens"

if [ "$failed" -ne 0 ]; then
	cat >&2 <<'MSG'

An identifier-shaped token in a tracked file is not on the allowlist.

This repository is public. If it belongs to a private system, remove it and use a
synthetic one. If it is genuinely public and belongs here, add it verbatim to
ALLOWED in this script -- deliberately, as its own reviewable change.
MSG
	exit 1
fi

echo 'check-identifiers: ok'
