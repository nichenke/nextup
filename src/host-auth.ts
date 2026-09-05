import { authStatusCommand, jiraIdentityCommand } from "./command-builders";
import type { Runner } from "./runner";

/**
 * Whether the gh/glab CLI itself reports being authenticated to `host`. Asks through each CLI's own
 * `--hostname` flag rather than text-matching free-form status output, so a future output format
 * change cannot silently misreport this. Tried both with and without a trailing `:port`, since which
 * form a self-hosted entry is keyed under depends on how the user originally logged in.
 *
 * Accepted risk: the bare-host fallback means a host authenticated only on its default port
 * is also treated as authenticated when pasted with an unrelated, unauthenticated port — a
 * different service on that port would be wrongly trusted. No real-world tracker deployment
 * splitting tenants by port on the same hostname is documented, so this is left unguarded
 * rather than adding an exact-host:port-only mode nothing currently needs.
 */
export function isAuthenticatedHost(tracker: "github" | "gitlab", host: string, runner: Runner): boolean {
	const check = (hostname: string): boolean => runner([...authStatusCommand(tracker, hostname)]).code === 0;
	if (check(host)) return true;
	const bare = host.replace(/:\d+$/, "");
	return bare !== host && check(bare);
}

/** Whether any Jira session exists; `jiraIdentityCommand` says why presence is the only signal. */
export function hasJiraAuth(runner: Runner): boolean {
	return runner([...jiraIdentityCommand()]).code === 0;
}
