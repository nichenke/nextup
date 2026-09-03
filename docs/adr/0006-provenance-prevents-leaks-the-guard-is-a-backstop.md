# Provenance prevents identifier leaks; the guard is a frozen backstop

An internal registry hostname reached this repo while it was public: `bun install` resolved through a
mirror and wrote that host into `bun.lock`, which was committed and pushed. What fixed the cause was
`bunfig.toml` pinning the public registry, so a lockfile can no longer record whatever mirror a machine
happens to resolve through, and CI now asserts that pin by exact comparison before any install.

`scripts/check-identifiers.sh` is kept for one job, stated narrowly because a broader claim is not
supportable: **it catches a canonical identifier a person pasted into a tracked file** — a scheme URL,
an email or scp-form remote, a schemeless host followed by a separator, a cross-repo issue reference.
Its recognition list is frozen, and findings that ask it to recognise one more spelling get closed.

The narrow scope is deliberate rather than modest. An earlier draft of this ADR justified the guard as
a backstop for machine-written identifiers, which has the value backwards: the machine-written case is
the one provenance closes, and the pin assertion closes it better than any matcher can. What survives
that is human paste — someone dropping an internal wiki link into a README — which the guard does catch
dependably, and which no amount of registry pinning prevents. Determinism is the right property for a
gate, but it does not make an unreliable check worth gating on; the pin assertion earns its place as a
gate, and this guard earns its place only for the paste case.

The decisive evidence is that the guard did not catch the leak it exists for. It was written, it had been
run by hand, and it had passed; `bun install` then generated `bun.lock` after that run, and the commit
included the new file. CI did not catch it either, for a reason that rhymes: the guard was ordered after
`bun install`, and the install failed on the very registry the guard would have flagged, so the one check
that would have caught it never executed. Two ordering and provenance changes — pin the registry, and run
the guard as CI's first step before any install — did more for this repo than any pattern work, because a
text matcher can only ever see what has already been written.

Pattern work here also has a measured own-goal rate that argues against more of it. An automated review of
the first hardening pass produced twelve findings, two of which were bugs introduced *by* that hardening:
a `\]` written mid-bracket-expression closed the class instead of escaping the bracket, silently disabling
punctuation trimming, and two unset variables inside a here-string made the guard check nothing and print
`ok`. A later pass added a third: introducing the schemeless-host shape made the guard fail on its own
source twice, both times on a comment that spelled out the fragment it was warning about, because
normalization turned the illustration into a live token. Every one of these was found by running the guard,
never by reading it, and the test suite passed throughout — including on the state where the guard exited 1.
The marginal pattern can silently disable the guard, so further recognition work has negative expected
value.

## Consequences

The allowlist holds whole tokens compared literally, and only whole tokens. Prefix matching for this
repo's own URLs was implemented and then removed: `grep -oE` emits a whole URL as one token, so accepting
anything under a prefix accepts a nested identifier inside it, and a copied URL carrying
`?redirect=<private-host>` passed the guard. Repairing that means re-scanning the accepted remainder,
which is the parsing this design exists to avoid. The cost is one allowlist line per issue URL referenced
in a tracked file, paid deliberately as its own reviewable change. If that friction starts producing
reflexive allowlist appends — the failure this repo should fear most, because a rubber-stamped allowlist
is how a real internal host gets added — the narrow fix is to accept a stripped remainder matching only
`/issues/<digits>` or `/pull/<digits>`, not to restore open prefix acceptance.

There is deliberately no tracker-key shape, and the reason is cost, not threat. A pasted internal ticket
key is the same human-paste class the guard exists for, and `nextup` reads ticket sets from Jira among
others, so tracker identifiers are first-class domain data that will turn up in fixtures and examples.
That residual risk is real and is accepted, because detection is unaffordable rather than unnecessary:
two-to-ten uppercase letters before a hyphen and digits is also how every standards identifier is
written, and on sampled prose for a tool about tickets, timestamps and integrity hashes it flagged
thirteen of sixteen tokens — date formats, hash and cipher names, RFC and CVE numbers, this repo's own
ADR citations. Worse, for multi-group tokens the extracted fragment is not what the author wrote:
`CVE-2024-3094` reported as `CVE-2024`, an allowlist line no reviewer can trace back to the file. A
guard that fires on ADR-0001 gets switched off or rubber-stamped, which costs more than the class it
catches. Closing this gap has to come from provenance — synthesising tracker references in fixtures
rather than copying real ones — not from a sharper pattern.

The schemeless shape requires a *dotted* host with a letters-only final label, so a single-label host
or an IP address in an otherwise canonical reference is missed: `registry:5000/team/app` and
`10.0.0.1:5000/team/app` both match nothing. These are ordinary container-registry forms, so this is a
real gap rather than a theoretical one. Relaxing the pattern to `name:port/path` would match ordinary
code and configuration — the same failure that rules out bare-host matching below — so it is accepted
on the same cost grounds as the tracker key.

A bare dotted host with no following separator is not matched either, because it is the same shape as
every `object.property` in the source; matching it flags the codebase rather than a leak. A doubled
backslash before a slash degenerates into that same gap. Both are recorded as tests naming them as the
nearest uncaught inputs, and neither should be widened without the other.

Percent-encoding, unicode escapes, HTML entities, base64, cross-line string concatenation and YAML folded
scalars are out of scope: each requires an actor deliberately obfuscating, and the threat model is
accidental machine-written output.

Denylists were rejected and stay rejected. A denylist of real internal hostnames would itself be the
content it guards. GitHub's secret scanning detects provider credential formats and its custom patterns
are org-scoped, so unavailable here; gitleaks and trufflehog are detector-rule driven with subtractive
allowlists and offer no deny-all-but-allowlist mode; `git-secrets` keeps patterns in git config, so CI
cannot read them; a private source with a sanitizing publish step relocates the denylist into the
sanitizer and publishes code no human reviewed in its published form. A word-level allowlist has the right
polarity but the wrong growth curve — tractable at 471 unique tokens today, intolerable once a real
dependency tree lands.

CI asserts the registry pin before any install, and asserts the *table* the key sits under rather than
the key's text. Two earlier versions of this check matched the line alone and passed on a file that
pinned nothing at all: the public line in the root table, under `[test]`, or under `[install.scopes]`,
with `[install]` unpinned or set to a mirror. Both were caught by review, not by the check, and the
second was written while fixing the first — the same one-more-spelling reflex this ADR rejects for the
guard, reappearing in the check meant to replace it. What holds is emitting `<table>|<line>` for every
registry assignment and comparing the whole output literally: missing, misplaced, scoped, duplicated
and altered keys all fail, and a duplicate emits a second line so the comparison catches it too. That
is table-aware without being a TOML parser, which matters here because the parsers are where the bugs
have been.

The pin check is still narrow, and saying so is the point: `BUN_CONFIG_REGISTRY` in the environment, a
stray `.npmrc`, and a scoped registry under `[install.scopes]` can each redirect a resolution without
touching the key this asserts. It guards the mechanism that actually leaked, not every mechanism that
could. It is the cheapest high-value check in the system because it guards a cause rather than a
symptom, not because it is complete. Documentation must not promise more than the guard delivers: a comment or README line
claiming broader coverage gets cited later to justify what the guard actually allows.

`check-identifiers: ok` is not assurance, and treating it as such is the most likely way this repo leaks
again. It printed exactly that on the day of the leak — the guard had been written, had been run, and had
passed, and `bun.lock` was generated afterwards. The line means one narrow class was not found in the
files as they stood when it ran. It says nothing about tracker keys, obfuscated encodings, bare
hostnames, or anything written after it. A reviewer who reads it as a clean bill of health has been given
a worse signal than no signal, which is why the scope above is stated in the negative as well as the
positive.

Remediation remains the floor and not the plan. It worked once — repo made private, commit rewritten,
republished — but it is mitigation rather than recovery: push events, forks and caches mean a public
exposure is never fully undone. That asymmetry is what justifies spending on provenance.
