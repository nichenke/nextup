import type { Runner } from "./runner";

/**
 * Whether `host` appears as a whole token in the gh/glab CLI's own authenticated-host listing.
 * Requires the status call itself to have succeeded — both CLIs can print a configured host in
 * their error output for an expired or invalid token, so a plain text search without the exit
 * code would accept a host the CLI just reported as broken. Word-boundary matching, not an
 * equality against a fixed host list, so a self-hosted enterprise host is recognised the same
 * way as the CLI's default one — but a plain substring match would also accept "hub.com"
 * against a listing for "github.com", so the boundary is required on both sides.
 */
export function isAuthenticatedHost(tracker: "github" | "gitlab", host: string, runner: Runner): boolean {
	const cmd = tracker === "github" ? ["gh", "auth", "status"] : ["glab", "auth", "status"];
	const result = runner(cmd);
	if (result.code !== 0) return false;
	const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const hostToken = new RegExp(`(?<![A-Za-z0-9.-])${escaped}(?![A-Za-z0-9.-])`);
	return hostToken.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * Jira's CLI config stores an API-gateway host, not the browse host a pasted link shows, so a
 * host-string comparison would compare against the wrong value. Presence of any authenticated
 * session is the only signal that holds.
 */
export function hasJiraAuth(runner: Runner): boolean {
	return runner(["jira", "me"]).code === 0;
}
