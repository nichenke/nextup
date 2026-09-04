# What each ranking rung reads

ADR-0003 fixes the ladder — priority, then unblocks-count, then reference — and the reference rung is
fully specified there. The other two name a signal without saying how it is read, and each has a
reading that looks obvious and is wrong.

**The priority rung reads a number and nothing else.** `P0`, `p2`, `priority:1` are the signal; a lower
number is more urgent. A `priority:` label carrying a name — `priority:high`, `priority:urgent` — is
*not* read, because ordering names needs a vocabulary no tracker supplies. Jira ships one and GitHub
and GitLab do not, so a vocabulary written here would be this tool's opinion applied to somebody else's
labels, and a wrong guess reorders a ticket set silently. Those labels are reported instead — against the
candidate that carried one, and as a set-wide summary — so a pick somebody disagrees with can be traced
to a label the ladder never read rather than looking like a label it read and overruled. A candidate
whose only priority label went unread is therefore distinguishable from one carrying no priority label
at all, which the ladder treats identically but a reader should not.

Only the candidates that reached the ladder are read for one. A ticket that was closed, claimed,
filtered out or confirmed blocked could not have won whatever its priority, and the selection's counts
already say why it did not.

A candidate carrying no priority at all sorts after every candidate that carries one. "Each rung is
skipped when its signal is absent" means skipped when *neither* candidate carries it, which is the
reading under which the rung is skipped for an unprioritised ticket set and applies as soon as anybody
prioritises anything.

**The unblocks rung counts open dependents.** Raw out-degree in the blocking graph counts closed
dependents too, which ranks a ticket highly for work that is already finished — a ticket five closed
tickets once waited on beats one that three open tickets are waiting on now, which inverts the rung's
whole purpose. Openness is read from the ticket's own `state`, the tracker's per-ticket truth.

## Consequences

The count is read from the blocking graph rather than from `Ticket.blockers`, so the rung and the
blocking derivation cannot come to disagree about which edges exist. A ticket whose own blockers came
back `"unknown"` contributes no edges, which makes every count a lower bound. That is the safe
direction: it understates how much a ticket unblocks rather than inventing dependents for it.

Dependents excluded from the candidate set still count. The label filter narrows what may be
recommended, not what the graph contains, and a wayfinder decision waiting on a backlog ticket is real
work that ticket unblocks.

Only direct dependents count, not transitive ones. A transitive count would rank the root of a long
chain above everything, which is close to the critical-path depth that ADR-0003 replaced — and it was
replaced because it needs a whole-graph reachability pass whose answer changes as unrelated edges
appear elsewhere. If the direct count picks badly, the fix is a scenario in `fixtures/scenarios/`
showing it, not a knob.
