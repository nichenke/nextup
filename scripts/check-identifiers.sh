#!/usr/bin/env bash
# Fails on any identifier-shaped token in a tracked file that is not allowlisted.
#
# The allowlist holds whole tokens, not hostnames or namespaces. Extracting "just the sensitive
# part" of a URL meant tracking git's URL grammar, and every version of that had a bypass: a
# nested GitLab namespace, an omitted SSH user, a port read as an owner, a native git:// remote
# matched by nothing. Whole-token matching has no grammar left to get wrong.
#
# It does not follow that an identifier cannot hide from it. The guard sees only what survives the
# normalization below, so an encoding this does not unescape is a bypass rather than a failure.
#
# What this dependably catches is a canonical identifier a person pasted in. The machine-written case
# -- a lockfile recording a private mirror, which is what actually leaked here -- is closed upstream by
# the registry pin in bunfig.toml, asserted in CI. So `ok` below means one narrow class was absent from
# the files as they stood when it ran, and nothing more. ADR-0006 states the scope and what it excludes.
#
# Deliberately not a denylist: a denylist of real hosts would itself be the content it guards, so
# publishing the guard would leak exactly what it protects.
set -euo pipefail

ALLOWED='
https://anthropic.com/claude-code/marketplace.schema.json
https://github.com/nichenke/nextup
https://github.com/nichenke/nextup/issues/2
https://github.com/nichenke/nextup/issues?q=is%3Aissue+label%3Aready-for-agent
https://registry.npmjs.org
https://example.com/issues/1
https://example.com/example/repo
https://example.com/example/repo.git
https://example.com/example/repo/issues/1
https://example.com/example/repo/pull/1
https://example.com/group/project/-/issues/1
https://example.com/group/subgroup/project.git
https://example.com/example/repo.git/
https://example.com/group/-/issues/1
https://example.com/group/subgroup/project/issues/1
https://example.com/browse/TEST-42
ssh://git@example.com/example/repo.git
git@example.com:example/repo.git
example.com:example/repo.git
example.com:8443
example.com/group/project/-/issues/1
example/repo#1
example/repo#8
group/project#8
myrepo#1
TEST-42
'

# Anything that can carry an identity: a scheme of any kind, an @ followed by a real host (an
# email or an scp-form remote), a host with no scheme at all, or a cross-repo issue reference.
# Broad on purpose -- a false positive costs one allowlist line, a false negative is a leak.
#
# The @ form requires a dotted host with a letters-only final label. Without that it matched
# every `package@version` in the lockfile and every pinned action version, which is noise no
# reviewer would read.
#
# The schemeless form requires a following `/` or `:`, which is what a container image reference,
# an .npmrc auth line and a schemeless URL all have. Matching a bare dotted host instead would
# flag every `object.property` in the source, because the two shapes are indistinguishable.
#
# There is deliberately no tracker-key shape here, on cost grounds rather than threat grounds: a
# pasted ticket key is in scope and is accepted as residual risk. Two-to-ten uppercase letters before
# a hyphen and digits is also how every standards identifier is written -- character encodings, the
# date format, hash and cipher names, RFC and CVE numbers, this repo's own ADR citations -- so it
# flagged thirteen of sixteen sampled tokens of ordinary prose, and a guard firing on ADR-0001 is one
# that gets rubber-stamped.
PATTERN='([a-z][a-z0-9+.-]*://[^[:space:]]+)|([A-Za-z0-9._%+/-]+@[A-Za-z0-9.-]*\.[A-Za-z]{2,}([:/][^[:space:]]*)?)|([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}[:/][^[:space:]]*)|([A-Za-z0-9._/-]+#[0-9]+)'

# A source literal can hold several identifiers separated by escape sequences, which give grep no
# whitespace to break on. Turning those escapes into real newlines splits the tokens apart.
# Truncating at the first escape instead -- which is what this did originally -- silently
# discarded everything after it, so a second URL hidden behind a `\n` passed unchecked.
#
# An escaped slash is the opposite case and has to be undone rather than split on. A URL whose
# slashes are backslash-escaped carries no literal scheme separator, so the scheme shape did not
# match it at all and the token was not merely mis-split but invisible.
#
# Unescaping runs first because it feeds the split: an escaped slash inside an escaped-newline
# segment has to become a slash before the segment is a URL worth splitting out. It also means a
# comment in this file cannot quote an escaped-slash URL -- normalization would turn the quote into
# a real one and the guard would flag its own source.
normalized=$(git ls-files -z | xargs -0 grep -Ih '' 2>/dev/null |
	awk '{ gsub(/\\\//, "/"); gsub(/\\[nrt]/, "\n"); print }' || true)

# Surrounding markup travels with a token: a markdown link wraps it in parentheses, prose ends it
# with a full stop, and a source-code string literal closes with a quote, sometimes escaped. None
# of that is part of the identifier.
#
# `]` leads the trailing class because a bracket expression cannot escape it -- written as `\]`
# further in, it closes the class instead, and trailing punctuation was silently never stripped.
tokens=$(printf '%s\n' "$normalized" | grep -oE "$PATTERN" |
	sed -E 's#^[[({<"'"'"'`]+##; s#[].,;:!?)}>"'"'"'`\\]+$##' | sort -u || true)

# Whole tokens, compared literally. Accepting anything *under* an allowed prefix was implemented and
# removed: grep emits a whole URL as one token, so a copied URL carrying `?redirect=` plus a private
# host was accepted before the inner host was ever looked at. Repairing that means re-scanning the
# accepted remainder, which is the parsing this design exists to avoid. See ADR-0006.
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
