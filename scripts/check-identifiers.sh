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

# A host allowlist alone passes a code host followed by a private org, since the org lives in
# the path. So namespaces are checked as well as hosts.
#
# GitHub and GitLab need different extraction. A GitHub namespace is exactly the first path
# segment, and the segments after it are a repo name and route words. A GitLab namespace nests
# arbitrarily and every segment of it is identity -- a private subgroup beneath an allowlisted
# top-level group is still a private name -- so the whole namespace is checked as one value.
#
# api.github.com is deliberately not namespace-checked: its paths begin with a route segment
# rather than a namespace, so the host check alone covers it.
ALLOWED_OWNERS='nichenke example-org'
GH_URL_RE='https?://github\.com/[A-Za-z0-9._-]+'
GL_URL_RE='https?://(gitlab\.com|gitlab\.example\.com)/[A-Za-z0-9._/-]+'

# Git remotes are frequently SSH rather than HTTP, in both scp form and ssh-scheme form, and
# neither carries an http scheme for the checks above to anchor on. That matters more here
# than in most repos: this tool discovers a repository from its git remote, so remotes are
# exactly what its fixtures will contain. Requiring at least two path segments keeps the
# pattern from swallowing bare email addresses, which have none, and captures a nested GitLab
# namespace in full rather than stopping at its first segment. The shapes are described rather
# than written out because a literal example would match this pattern and fail on this file.
SSH_REMOTE_RE='(ssh://)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+[:/][A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+'

failed=0

hosts=$(git ls-files -z | xargs -0 grep -IhoE 'https?://[A-Za-z0-9._:-]+' 2>/dev/null |
	sed -E 's#^https?://##' | sort -u || true)

ssh_remotes=$(git ls-files -z | xargs -0 grep -IhoE "$SSH_REMOTE_RE" 2>/dev/null | sort -u || true)
ssh_hosts=$(printf '%s\n' "$ssh_remotes" |
	sed -E 's#^(ssh://)?[A-Za-z0-9._-]+@##; s#[:/].*$##' | sort -u)
# A remote path is always namespace plus repo, on either host, so dropping the final segment
# yields the namespace -- one segment on GitHub, however many on GitLab.
ssh_owners=$(printf '%s\n' "$ssh_remotes" |
	sed -E 's#^(ssh://)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+[:/]##; s#\.git/?$##; s#/$##; s#/[^/]+$##' |
	grep -v '^$' | sort -u || true)

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

gh_owners=$(git ls-files -z | xargs -0 grep -IhoE "$GH_URL_RE" 2>/dev/null |
	sed -E 's#^https?://[^/]+/##' | sort -u || true)

# Everything before the `/-/` route separator, or the whole path where there is none, minus the
# final project segment.
gl_owners=$(git ls-files -z | xargs -0 grep -IhoE "$GL_URL_RE" 2>/dev/null |
	sed -E 's#^https?://[^/]+/##; s#/-/.*$##; s#/$##; s#/[^/]+$##' | grep -v '^$' | sort -u || true)

ref_owners=$(git ls-files -z | xargs -0 grep -IhoE '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+' 2>/dev/null |
	sed -E 's#/.*##' | sort -u || true)

while IFS= read -r owner; do
	[ -n "$owner" ] || continue
	if ! printf '%s\n' $ALLOWED_OWNERS | grep -qxF "$owner"; then
		printf 'disallowed repository namespace: %s\n' "$owner" >&2
		failed=1
	fi
done <<<"$(printf '%s\n%s\n%s\n%s\n' "$gh_owners" "$gl_owners" "$ref_owners" "$ssh_owners" | sort -u)"

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
