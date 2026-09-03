import type { Runner } from "./runner";

/**
 * Whether the gh/glab CLI itself reports being authenticated to `host`. Uses each CLI's own
 * `--hostname` flag rather than text-matching free-form status output, so a future CLI output
 * format change can't silently misreport this. `gh auth status --hostname` exits 1 if ANY
 * account on that host has an auth problem, even an inactive secondary one, so `gh` also passes
 * `--active` to check only the account that would actually be used (`gh auth status --help`;
 * `glab` has no equivalent multi-account concept). Tried both with and without a trailing
 * `:port`, since which form a self-hosted entry is keyed under depends on how the user
 * originally logged in.
 *
 * Accepted risk: the bare-host fallback means a host authenticated only on its default port
 * is also treated as authenticated when pasted with an unrelated, unauthenticated port — a
 * different service on that port would be wrongly trusted. No real-world tracker deployment
 * splitting tenants by port on the same hostname is documented, so this is left unguarded
 * rather than adding an exact-host:port-only mode nothing currently needs.
 */
export function isAuthenticatedHost(tracker: "github" | "gitlab", host: string, runner: Runner): boolean {
	const check = (hostname: string): boolean => {
		const cmd =
			tracker === "github"
				? ["gh", "auth", "status", "--hostname", hostname, "--active"]
				: ["glab", "auth", "status", "--hostname", hostname];
		return runner(cmd).code === 0;
	};
	if (check(host)) return true;
	const bare = host.replace(/:\d+$/, "");
	return bare !== host && check(bare);
}

/**
 * Jira's CLI config stores an API-gateway host, not the browse host a pasted link shows, so a
 * host-string comparison would compare against the wrong value. Presence of any authenticated
 * session is the only signal that holds.
 */
export function hasJiraAuth(runner: Runner): boolean {
	return runner(["jira", "me"]).code === 0;
}
