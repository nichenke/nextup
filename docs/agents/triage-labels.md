# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Category labels

Triage also applies exactly one category role alongside the state role. Both use GitHub's default
label strings:

| Canonical role | Label in our tracker |
| -------------- | -------------------- |
| `bug`          | `bug`                |
| `enhancement`  | `enhancement`        |

The repo also carries a `spec` label, which is not part of the triage vocabulary. It marks an issue
whose body is itself the specification rather than a report, and it composes with a state role
rather than replacing one.
