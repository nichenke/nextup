import type { GitHubTicketRef, TicketRef } from "./ticket-ref";
import type { Ticket } from "./ticket";

const raw = { tracker: "github" as const, repo: "a/b", key: "1", host: "ghe.example" };
export const viaVar: GitHubTicketRef = raw;

type Narrowed = Ticket & { readonly ref: GitHubTicketRef };
export function widenBack(t: Narrowed, other: TicketRef): void {
  const alias: { ref: TicketRef } = t;
  alias.ref = other;
}
