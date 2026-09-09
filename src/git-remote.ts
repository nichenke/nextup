import { originRemoteCommand } from "./command-builders";
import type { Runner } from "./runner";

const URL_REMOTE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i;
const SCP_REMOTE = /^(?:[^@\s]+@)?([^:\s@]+):(.+)$/;

/** Both halves of a git remote, so a caller that must know which system it points at can ask. */
export interface RemoteAddress {
	/** Lower-cased, keeping any port, since a host is compared rather than displayed. */
	readonly host: string;
	readonly repo: string;
}

export function parseRemote(remote: string): RemoteAddress | null {
	const match = URL_REMOTE.exec(remote) ?? SCP_REMOTE.exec(remote);
	const host = match?.[1];
	const path = match?.[2];
	if (!host || !path) return null;
	const repo = path.replace(/\/+$/, "").replace(/\.git$/, "");
	return repo === "" ? null : { host: host.toLowerCase(), repo };
}

/** The repository path segment of a git remote URL, minus a trailing `.git` and slash. */
export function parseRepoPath(remote: string): string | null {
	return parseRemote(remote)?.repo ?? null;
}

export function resolveRepoFromOrigin(runner: Runner): string | null {
	return resolveOriginRemote(runner)?.repo ?? null;
}

export function resolveOriginRemote(runner: Runner): RemoteAddress | null {
	const result = runner([...originRemoteCommand()]);
	if (result.code !== 0) return null;
	return parseRemote(result.stdout.trim());
}
