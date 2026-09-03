import type { Runner } from "./runner";

/**
 * Whether the gh/glab CLI itself reports being authenticated to `host`. Uses each CLI's own
 * `--hostname` flag rather than text-matching free-form status output, so a future CLI output
 * format change can't silently misreport this. A trailing `:port` is stripped first — both
 * CLIs report and match on bare hostnames.
 */
export function isAuthenticatedHost(tracker: "github" | "gitlab", host: string, runner: Runner): boolean {
	const hostname = host.replace(/:\d+$/, "");
	const cmd =
		tracker === "github"
			? ["gh", "auth", "status", "--hostname", hostname]
			: ["glab", "auth", "status", "--hostname", hostname];
	return runner(cmd).code === 0;
}

/**
 * Jira's CLI config stores an API-gateway host, not the browse host a pasted link shows, so a
 * host-string comparison would compare against the wrong value. Presence of any authenticated
 * session is the only signal that holds.
 */
export function hasJiraAuth(runner: Runner): boolean {
	return runner(["jira", "me"]).code === 0;
}
