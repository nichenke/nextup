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

# Removed here rather than through the tool's runner: this runs before any dependency install. ADR-0029.
unset "${!GIT_@}"

# `git ls-files` lists what is under the current directory, so a run from a subdirectory would scan a subset
# and pass. The whole tree or nothing; ADR-0029 carries the count that showed it.
if toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
	if ! cd "$toplevel"; then
		printf 'check-identifiers: cannot enter %s, so no file was scanned\n' "$toplevel" >&2
		exit 1
	fi
fi

# Both scan pipelines below end in `|| true`, so anything leaving them without input reads as nothing found.
# ADR-0029 has why each cause gets its own message.
if ! tracked=$(git ls-files); then
	printf 'check-identifiers: git ls-files failed, so no file was scanned\n' >&2
	exit 1
fi

if [ -z "$tracked" ]; then
	printf 'check-identifiers: nothing is tracked here, so a pass would mean nothing\n' >&2
	exit 1
fi

# A sparse checkout keeps tracked files out of the worktree, so the scan reads a subset and passes -- measured
# with the identifier in the excluded file. Asked of git rather than inferred from a file being absent, because
# an unstaged deletion looks identical on disk and is an everyday state, not a reason to refuse.
# `--bool` rather than a literal comparison: git accepts `yes`, `on`, `1` and `TRUE` for a boolean and honours
# them, while `--get` returns whatever the file says -- so comparing the raw value misses a sparse checkout
# spelled any of those ways. Measured: a config holding `yes` reads back as `yes` raw and `true` as a bool.
if [ "$(git config --bool --get core.sparseCheckout || true)" = "true" ]; then
	printf 'check-identifiers: this is a sparse checkout, so a scan would cover part of the tree\n' >&2
	exit 1
fi

# A tracked file the scan cannot open is skipped exactly as an absent one is, and the scan discards the error.
# An unstaged deletion is the one shape of that worth tolerating, because it leaves no content on disk. Two
# questions, because no single test answers both: `[ -e ]` cannot see through an unreadable directory, and git
# reports a path behind one as deleted.
#
# The order is the mechanism here, not the streams. A path git cannot lstat appears on stdout *and* stderr; a
# genuine deletion appears on stdout alone. Measured. So the stderr test has to run before the deleted-list
# test below -- reversed, an unstattable path lands in that list, matches it, and is tolerated, which is the
# hole this closes.
#
# What git wrote is reported verbatim and the second line does not name a cause, because this cannot tell an
# unreadable path from a broken git: a bad `core.fsmonitor` also writes here, and both exit 0. Measured.
listing_diagnostic=$(git ls-files --deleted 2>&1 >/dev/null)
if [ -n "$listing_diagnostic" ]; then
	printf 'check-identifiers: %s\n' "$listing_diagnostic" >&2
	printf 'check-identifiers: git could not list the tree cleanly, so a scan would cover part of it\n' >&2
	exit 1
fi

# One listing, written where its exit status can be checked: piping `git ls-files -z` straight into a reader
# discards that status, and a listing that failed part way through then reads as nothing found. A command
# substitution cannot hold it instead, because bash strips the NUL that `xargs -0` separates on. ADR-0029.
listing=$(mktemp "${TMPDIR:-/tmp}/check-identifiers.XXXXXX")
trap 'rm -f "$listing"' EXIT
if ! git ls-files -z >"$listing"; then
	printf 'check-identifiers: git ls-files failed while listing the tree, so no file was scanned\n' >&2
	exit 1
fi

# Then the paths git could examine: a mode-000 file can be stat'ed and not read, so it reaches neither the
# error above nor the deleted list.
deleted=$(git ls-files --deleted)
symlink_targets=''
while IFS= read -r -d '' path; do
	# grep reads a file named `-` as standard input even after the `--` the scan passes, so its contents never
	# reached the scan. ADR-0029 has why this is refused rather than scanned.
	if [ "$path" = '-' ]; then
		printf 'check-identifiers: a tracked file named - is read as standard input, so a scan would cover part of the tree\n' >&2
		exit 1
	fi
	# A symlink's tracked content is its target path, and the scan never sees it: grep follows the link and
	# reads whatever it points at instead. Read rather than refused, which covers a dangling link too, where
	# `[ -r ]` is false but there is still a target to scan. ADR-0029.
	if [ -L "$path" ]; then
		symlink_targets="$symlink_targets$(readlink -- "$path")
"
		continue
	fi
	if [ ! -r "$path" ] && ! printf '%s\n' "$deleted" | grep -qxF -- "$path"; then
		printf 'check-identifiers: %s is tracked but cannot be read, so a scan would cover part of the tree\n' "$path" >&2
		exit 1
	fi
done <"$listing"

ALLOWED='
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
https://example.com/group/project/-/issues/037
https://EXAMPLE.com/group/project/-/issues/1
https://example.com/group/subgroup/project.git
https://example.com/example/repo.git/
https://example.com/group/-/issues/1
https://example.com/project/-/issues/1
https://example.com/group//project/-/issues/1
https://example.com/?next=/group/project/-/issues/1
https://alice@example.com/group/project/-/issues/1
https://example.com/group/subgroup/project/issues/1
https://example.com/browse/TEST-42
https://example.com/jira/browse/TEST-42
https://example.com/justrepo.git
ssh://git@example.com/example/repo.git
git@example.com:example/repo.git
example.com:example/repo.git
example.com:8443
example.com/group/project/-/issues/1
example/repo#0
example/repo#1
example/repo#2
example/repo#037
example/repo#3
example/repo#4
example/repo#8
example/repo#9
example/repo#10
example/repo#100
group/project#8
myrepo#1
repo#1
proj#42
owner/#1
owner/sub/repo#1
/repo#1
group//repo#1
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
# `--` because a tracked filename may begin with a hyphen, which grep would otherwise read as an option: a
# file named `-d` made BSD grep reject its own argument list, the error went to /dev/null, and the guard
# printed `ok` over the identifier inside it. Measured.
#
# The symlink targets collected above join the file contents here: they are tracked content grep never
# reaches, so they need the same normalization and the same allowlist comparison.
normalized=$({
	xargs -0 grep -Ih '' -- <"$listing" 2>/dev/null || true
	printf '%s' "$symlink_targets"
} | awk '{ gsub(/\\\//, "/"); gsub(/\\[nrt]/, "\n"); print }' || true)

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
