# Checkout identity is resolved once and a write cannot happen without one

Which repository the command was invoked in is now one value, `CheckoutIdentity`, resolved at most once
per run and passed to everything that writes. It used to be a question three call sites asked git
separately and compared for themselves.

[0038](./0038-enterprise-is-out-of-scope-and-out-of-scope-means-unrepresentable.md) is the other half:
the reference side, and the five checks this pair replaced, with the order they were added in.

## The three callers collapse into one resolver

`resolveOriginRemote` had three callers — `cli.ts`, the read adapter, and the short-form resolver — plus
one in `scripts/reconstruct.ts`. Each did the same two things afterwards: refuse a null, then refuse a
host that is not GitHub's. Three null checks agreeing by accident is not the same as one rule.

`resolveCheckoutIdentity` is now the only caller. It answers with a repository path or throws, and the
GitHub-host test is inside it rather than beside each call.

The distinct error classes stay, because they encode different recoveries: `cli.ts` reads the class to
decide what a failed start leaves open, `ticket-ref.ts` raises a bad reference, and
`scripts/reconstruct.ts` a run that cannot be made. So the resolver takes a `refuse` callback that builds
the caller's own class from a reason the resolver supplies. One decision, three framings.

The callback's type says "produce an `Error`", not "produce your own class", so nothing stops a caller
passing `(r) => new Error(r)` and collapsing exactly what this preserves. That invariant is documentation
rather than enforcement, which is worth knowing in a change spent removing such things; no type-level fix
looked worth its complexity.

## The value has no unresolved state

There is no unknown arm and no nullable field. Every reader of this value is deciding whether a write may
happen, and "we could not tell" has exactly one safe answer there, which is to refuse. A value that could
carry the absence would mean every consumer re-deciding what to do about it — which is the arrangement
this replaced.

The repository path is folded to lower case here, so every comparison against a reference is `===`. The
two `.toLowerCase()` folds that used to sit at the comparison sites are gone, because both sides are
normalized where they were built.

## Resolved once, and the count is the assertion

`cli.ts` builds one memoized resolver per run and threads it: to `resolveTicketRef`, which needs it for a
bare `gh:<number>`; to the set read, which used to fall back to the adapter's own lookup; to the check
that a named ticket belongs here; and to the claim. A bare short form therefore reads the remote once
where it used to read it twice, and `cli.test.ts` pins that count.

The point is not the saved subprocess. It is that the reference the run resolved, the set it ranked, the
ticket it checked and the repository it claimed in cannot disagree about where "here" is, because there
is only one answer and they all hold it.

`GitHubReadInput.repo` became required and the adapter's own origin lookup is gone. It had no caller left:
`cli.ts` and `scripts/reconstruct.ts` both resolve an identity first and pass the path in. The adapter
reads a repository somebody else decided on and no longer decides which one.

## A write takes one as a parameter

`claimGitHubTicket` requires a `CheckoutIdentity` and refuses a reference naming another repository.

On the named path that repeats a comparison `cli.ts` already made. On the ranked path it is the *only*
one, which is the thing to know before anyone deletes it as redundant: `cli.ts` never compares a ranked
reference against the checkout — it scopes the read to this repository and stops there — and
`requireOneRepository` deliberately tolerates rows answering under a different name, because a rename
redirects. So a repository renamed on GitHub with a stale local remote produces ranked references naming
a repository this checkout is not, with nothing upstream to notice.

`CheckoutIdentity` is branded with a symbol only this module can name, so `resolveCheckoutIdentity` is the
only thing that produces one — in tests as much as in production. Without the brand the type is
structurally `{ repo: string }`, and the value this module deliberately does not hand to a write —
`resolveCheckoutRepoPath`'s unfolded path off any host — could be passed straight into the claim as one.

A test-facing factory was tried and removed: it was a door into the brand that production lacked, and the
tests did not need it. `github-claim.test.ts` stands its checkout up through the real resolver off a fake
remote, which exercises the host test and the fold rather than skipping them. ADR-0038 rejects branding
for `GitHubTicketRef` on a different ground, which is that its tests assert the shape a resolver produces
and a brand would make those assertions compare the constructor against itself.

This is a refusal before the write, so it leaves the tracker untouched, which is what
[0016](./0016-the-worktree-is-created-before-the-claim.md) intends. It arbitrates nothing and is not a
step toward it; [0018](./0018-concurrent-claim-arbitration-is-out-of-scope.md) is still the boundary.

## The one reading that is not an identity

A bare `glab:<number>` needs the path its remote spells, on whatever host, unfolded. That is a different
question — a GitLab instance can be any host, so there is no host test to pass, and whether GitLab
resolves a path case-insensitively is issue 15's to decide from a cited source. `resolveCheckoutRepoPath`
is that reading, it sits beside the identity resolver so `resolveOriginRemote` still has exactly one
caller, and it is deliberately not a `CheckoutIdentity`: nothing that writes will take it.

## Consequences

Which git command reads the origin remote is now one call site for issue 53 to decide for, rather than
four.

`resolveRepoFromOrigin` and `parseRepoPath` are gone. Both were exported from `git-remote.ts` with no
production caller, and the first would have been a second caller of `resolveOriginRemote`.

A run in a directory with no origin remote now fails with the wording of whichever step asked, rather
than with whichever of the four checks happened to run first. The exit status is unchanged.

A ranked run in a checkout whose remote still spells a repository's old name now refuses at the claim,
where before it claimed under the new name. That is a new refusal on a path that worked, and it is the
one this consolidation adds deliberately: the tool cannot tell a rename from a different repository at
the same path, and the single-ticket read already refuses the same shape. The remedy is to correct the
remote, which the message names.
