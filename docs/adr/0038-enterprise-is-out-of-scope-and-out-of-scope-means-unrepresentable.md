# Enterprise is out of scope, and out of scope means unrepresentable

This tool works against GitHub's own host and no other. That was already true, and it was enforced by
five separate checks that each asked a consumer to notice the thing the reference should never have been
able to say. `TicketRef` is now a discriminated union whose GitHub variant has no host field at all, is
built only from a validated repository path and a canonical issue key, and folds that path to lower case
at construction. The scope decision is the type.

[0039](./0039-checkout-identity-is-resolved-once-and-a-write-cannot-happen-without-one.md) is the other
half: the remote side, and what "which repository am I standing in" became.

## Five checks, three review rounds, one invariant

Each landed after a review found the previous set insufficient, and the order tells the story:

| # | Where | What it asked | Added because |
| --- | --- | --- | --- |
| 1 | `requireTicketInThisCheckout` in `cli.ts` | the reference against the checkout's remote, path | a pasted URL from another repository claimed there |
| 2 | the host half of the same check | …and host | the path comparison alone accepted a checkout on another host |
| 3 | `githubTicketTarget` in `ticket-ref.ts` | that a reference names an actionable GitHub ticket | the claim and the override path's read needed one answer |
| 4 | the response-identity check in `readGitHubTicket` | that the issue answered about is the one asked for | a transferred issue passed the number comparison |
| 5 | `requireGitHubOrigin`, and the short-form resolver's host branch | that the origin remote is on GitHub | a bare `gh:12` in an Enterprise checkout read github.com |

[0032](./0032-the-claim-refuses-two-shapes-a-zero-exit-would-not-warn-about.md) names 4 and 5 as "the two
existing checks" without connecting them to 1–3, which is the shape of a missing abstraction rather than
three bugs. The worry was never any of these checks. It was the next route nobody had thought of.

## What the union settles

- **The GitHub variant carries no host.** A reference on another host is not a GitHub reference held
  loosely; it is not one at all. `{ tracker: "github", repo, key, host }` is a compile error, so checks
  1, 2 and the host half of 3 have nothing left to compare.
- **Its repository path is validated and folded.** Exactly two non-empty segments — GitHub has no
  subgroups, and `gh` reads `--repo` as `[HOST/]OWNER/REPO`, so a third segment is a host. Folded,
  because GitHub resolves the path case-insensitively while a git remote records whatever was typed.
- **Its key is a canonical issue number.** The rule moved here from the argv boundary, which is the
  layer that could not reach the consumers that matter.

One thing the type does not carry: `repo` and `key` are plain strings, so an object literal spelling
`{ tracker: "github", repo: "Owner/Repo/Extra", key: "007" }` still compiles. Only the host is
unrepresentable; the other two invariants hold because `githubTicketRef` is the documented and only
builder, and every production construction site goes through it.

Branding both fields would close that too, and was left out deliberately, for a reason narrower than
cost: the tests assert the *shape* a resolver produces — `expect(ref).toEqual({ tracker, repo, key })` —
and a brand forces every such assertion to compare the constructor's output against the constructor,
which pins nothing. `CheckoutIdentity` is branded precisely because it has no such assertion to lose.
The honest reading is that the host is a type fact and the other two are a convention the tests can
still teach a future call site to break; that is the residual, and it is here rather than unrecorded.

The host is the one that had to be a type fact regardless, because it is the one a reference could
legitimately *carry* and a consumer had to notice.

`githubTicketTarget` survives as a narrowing and nothing else. GitLab's variant keeps its host and its
path as spelled: whether GitLab resolves a path case-insensitively belongs to issue 15, which wants a
cited source rather than an inference from GitHub's behaviour. The union is what makes leaving that
undecided safe — nothing GitHub-shaped depends on it.

## The acceptance this removes

`resolveTicketRef` used to decide a two-segment `/<a>/<b>/issues/<n>` URL by asking both CLIs which hosts
they were authenticated to. That treats authentication as evidence of which tracker a URL belongs to,
and for GitHub Enterprise the evidence points the wrong way: `gh` really is authenticated there, so the
URL resolved as a GitHub reference and reached a claim that carries no hostname.

The host decides now, and only the host. GitHub serves its issues from the authorities `isGitHubHost`
enumerates and nowhere else, so a URL on one of them is GitHub's whatever `gh` says, and a URL on any
other is not. `glab` is still asked, because a GitLab instance really can be any host. A two-segment URL
that is neither is refused with a message naming the scope boundary rather than reporting an unrecognized
URL — the URL *was* recognized; what it names is out of scope, and those are different things to be told.

The ambiguity case goes with it. A host both CLIs answer for used to be a loud failure; it is now GitLab,
because the only way to be GitHub is to be on GitHub's host.

## Consequences

Three identity merges follow, each of which used to give one GitHub ticket two graph keys depending on
how its reference was obtained. `ticketId` keys the blocking graph, and two keys for one ticket means two
nodes whose openness overwrite each other.

- **Host.** A pasted URL kept `host` set; every reference the adapter emits set it null. One ticket held
  `["github","github.com","owner/repo","1"]` and `["github",null,"owner/repo","1"]`.
- **Repository case.** `parseRemote` folds the host and deliberately leaves the repository path as
  spelled, so `NicHenke/NextUp` and `nichenke/nextup` were two identities for one ticket. Two sites
  hand-folded case at comparison time instead — the named-ticket check in `cli.ts` and the read's
  response-identity check — and both now compare with `===`. That GitHub resolves the
  path case-insensitively is not measured here: [0027](./0027-blocking-is-read-from-edges-and-unknown-is-never-a-zero.md)
  infers it from exactly this collision, observed live, and that is the evidence the fold rests on.
- **Key.** Issue 56's measurement, reproduced rather than paraphrased — gh 2.100.0:

  | step | result |
  | --- | --- |
  | `resolveTicketRef` on a short form whose number is written `037` | accepted, `key: "037"` |
  | `gh issue view --repo <repo> -- 022` against the test tree | issue **22**, with and without `--` |
  | `compareTicketRefs("037", "37")` | `-1` |

  `compareKeys`' own docstring already stated the rule this violated: "`07` and `7` are numerically equal
  and are different tickets." That rule is unchanged. What changed is that a padded key can no longer be
  built, so the ladder never sees the pair.

All three were latent rather than live when this landed: references from a pasted URL and references from
the adapter never entered one graph, so no test reproduced a live failure and none claims to.

Issue 56 is closed by this rather than sequenced after it. Its open question — refuse or canonicalize —
is answered refuse, consistent with how this repo treats input it cannot represent faithfully: a URL that
GitHub itself would redirect is a bad reference, not one to silently rewrite.

`requireCanonicalIssueKey` still runs inside `githubIssueViewCommand` and `githubClaimCommand`, and it is
now unreachable from a `GitHubTicketRef`. It stays because those builders take a bare `repo` and `key`
rather than a reference, so a caller reaching past the reference types can still spell either badly — and
the capture script does exactly that, though with the repository rather than the key: it hands the builder
a three-segment host-carrying path to capture `claim-outage`. 0032 is explicit that loosening the argv
guard is what opens the hole, so it is kept rather than relaxed.

Supporting GitHub Enterprise is still out of scope. This records the boundary; it does not move it. What
it changes is that moving it later means widening a type rather than finding every check that agreed by
accident.
