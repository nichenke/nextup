import type { Runner } from "./runner";

const URL_REMOTE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i;
const SCP_REMOTE = /^[^@\s]+@[^:\s]+:(.+)$/;

/** The repository path segment of a git remote URL, minus a trailing `.git` and slash. */
export function parseRepoPath(remote: string): string | null {
	const match = URL_REMOTE.exec(remote) ?? SCP_REMOTE.exec(remote);
	const path = match?.[1];
	if (!path) return null;
	return path.replace(/\.git$/, "").replace(/\/+$/, "") || null;
}

export function resolveRepoFromOrigin(runner: Runner): string | null {
	const result = runner(["git", "remote", "get-url", "origin"]);
	if (result.code !== 0) return null;
	return parseRepoPath(result.stdout.trim());
}
