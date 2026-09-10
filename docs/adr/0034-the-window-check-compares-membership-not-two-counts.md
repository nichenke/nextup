# The window check compares membership, not two counts

Status: amends ADR-0033 on two points. Everything else there stands.

ADR-0033 argues the independent reader needs no fixture because every way it can be wrong already surfaces as a
failing check. The first item on that list was `whole-set-read` comparing the two sides' counts. It does not
establish what the argument needs, and this records what replaced it.

## A count does not see a dropped or invented ticket

Two sides holding different tickets balance whenever the same number entered as left. A read of two tickets
against an observation of two others counts alike, and then nothing below sees the difference either:
`edgesAgree` skips a read ticket the tracker never observed, and a ticket only the tracker saw reaches no check
unless it is frontier-worthy there — which a claimed or filtered one is not. Both extras claimed, the harness
reported eleven green checks over two different windows.

So `whole-set-read` compares the ticket sets, in both directions, and does the same for the blocking-field-less
read against the ordinary one. ADR-0033's first bullet should be read as naming that comparison.

A ticket the read withheld for arriving with a page of its blockers counts as met. The adapter read that row and
held it out deliberately, so counting it unread reported one paging degrade three times over — as the degrade,
as a ticket missing from the read, and as a surplus in the blind read, which has no short node list to withhold
anything and so returns it.

Deliberately not narrowed the same way: `expectedFrontier` still reads every observation, so a frontier-worthy
ticket the adapter dropped faults in `frontier-agrees` rather than being excused as one side's surplus.

## What a short node list reads as

ADR-0033's edges-agree section describes the adapter reading an absent `blockedBy` and a short node list as
`"unknown"`. The absent field does. A node list that does not match its own count reads `"partial"`, which holds
the ticket out of the answer entirely rather than leaving it in as unjudged.

That section's conclusion is unaffected — no edge is lost into an empty list, which is why a correlated loss is
unreachable on the GitHub path today — but the two readings are not interchangeable, and ADR-0027 is where each
is argued.
