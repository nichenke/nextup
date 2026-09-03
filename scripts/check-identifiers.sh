#!/usr/bin/env bash
# Fails on any URL host or issue-key token that is not on the synthetic allowlist.
#
# Deliberately an allowlist rather than a denylist: a denylist of real hostnames and
# project keys would itself be the content it guards, so publishing the guard would
# leak exactly what it protects.
#
# Word boundaries (\b, [[:<:]]) are avoided for portability between BSD and GNU grep, so
# the key pattern over-matches inside longer tokens. That is the safe direction for a
# guard, but the prefix is restricted to letters: allowing digits made the pattern match
# a substring of its own character class, which fired on this file. The cost is that a
# project key with a digit in its prefix goes unmatched; those are treated as out of
# contract rather than supported.
set -euo pipefail

ALLOWED_HOSTS='
example.com
example.org
example.net
gitlab.example.com
example.atlassian.net
github.com
api.github.com
gitlab.com
registry.npmjs.org
bun.sh
code.claude.com
anthropic.com
localhost
'

ALLOWED_KEY_PREFIXES='TEST ABC DEMO FOO XYZ ADR UTF SHA ISO RFC BASE'

failed=0

hosts=$(git ls-files -z | xargs -0 grep -IhoE 'https?://[A-Za-z0-9._:-]+' 2>/dev/null |
	sed -E 's#^https?://##' | sort -u || true)

while IFS= read -r host; do
	[ -n "$host" ] || continue
	bare=${host%%:*}
	if ! printf '%s\n' "$ALLOWED_HOSTS" | grep -qxF "$bare"; then
		printf 'disallowed host: %s\n' "$host" >&2
		failed=1
	fi
done <<<"$hosts"

keys=$(git ls-files -z | xargs -0 grep -IhoE '[A-Z]{2,10}-[0-9]+' 2>/dev/null |
	sort -u || true)

while IFS= read -r key; do
	[ -n "$key" ] || continue
	prefix=${key%%-*}
	if ! printf '%s\n' $ALLOWED_KEY_PREFIXES | grep -qxF "$prefix"; then
		printf 'disallowed issue-key token: %s\n' "$key" >&2
		failed=1
	fi
done <<<"$keys"

if [ "$failed" -ne 0 ]; then
	cat >&2 <<'MSG'

An identifier outside the synthetic allowlist was found in a tracked file.

This repository is public. If the identifier belongs to a private system, remove it
and use a synthetic one. If it is genuinely public and belongs here, add it to the
allowlist in this script -- deliberately, as its own reviewable change.
MSG
	exit 1
fi

echo 'check-identifiers: ok'
