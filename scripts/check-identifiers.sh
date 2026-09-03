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

# A host allowlist alone passes github.com/<private-org>/<repo>, since the org lives in
# the path. So the first path segment of a code-host URL, and the owner half of a
# cross-repo `owner/repo#n` reference, are checked too. Only the three web hosts below
# are owner-checked: api.github.com paths begin with a literal route segment rather than
# an owner, so it is covered by the host check alone.
ALLOWED_OWNERS='nichenke example-org'
OWNER_URL_RE='https?://(github\.com|gitlab\.com|gitlab\.example\.com)/[A-Za-z0-9._-]+'

# Git remotes are frequently SSH rather than HTTP, in both scp form and ssh-scheme form, and
# neither carries an http scheme for the checks above to anchor on. That matters more here
# than in most repos: this tool discovers a repository from its git remote, so remotes are
# exactly what its fixtures will contain. Requiring a trailing owner segment keeps the
# pattern from swallowing bare email addresses. The shapes are described rather than written
# out because a literal example would match this pattern and fail on this file.
SSH_REMOTE_RE='(ssh://)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+[:/][A-Za-z0-9._-]+/'

failed=0

hosts=$(git ls-files -z | xargs -0 grep -IhoE 'https?://[A-Za-z0-9._:-]+' 2>/dev/null |
	sed -E 's#^https?://##' | sort -u || true)

ssh_remotes=$(git ls-files -z | xargs -0 grep -IhoE "$SSH_REMOTE_RE" 2>/dev/null | sort -u || true)
ssh_hosts=$(printf '%s\n' "$ssh_remotes" |
	sed -E 's#^(ssh://)?[A-Za-z0-9._-]+@##; s#[:/].*$##' | sort -u)
ssh_owners=$(printf '%s\n' "$ssh_remotes" |
	sed -E 's#^(ssh://)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+[:/]##; s#/.*$##' | sort -u)

while IFS= read -r host; do
	[ -n "$host" ] || continue
	bare=${host%%:*}
	if ! printf '%s\n' "$ALLOWED_HOSTS" | grep -qxF "$bare"; then
		printf 'disallowed host: %s\n' "$host" >&2
		failed=1
	fi
done <<<"$(printf '%s\n%s\n' "$hosts" "$ssh_hosts" | sort -u)"

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

url_owners=$(git ls-files -z | xargs -0 grep -IhoE "$OWNER_URL_RE" 2>/dev/null |
	sed -E 's#^https?://[^/]+/##' | sort -u || true)

ref_owners=$(git ls-files -z | xargs -0 grep -IhoE '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+' 2>/dev/null |
	sed -E 's#/.*##' | sort -u || true)

while IFS= read -r owner; do
	[ -n "$owner" ] || continue
	if ! printf '%s\n' $ALLOWED_OWNERS | grep -qxF "$owner"; then
		printf 'disallowed repository owner: %s\n' "$owner" >&2
		failed=1
	fi
done <<<"$(printf '%s\n%s\n%s\n' "$url_owners" "$ref_owners" "$ssh_owners" | sort -u)"

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
