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

/**
 * The origin remote of `directory`, or null where there is none to read. A null is turned into a refusal by
 * ADR-0040's resolver.
 *
 * The first URL of however many the remote carries, which is the one git fetches from — `originRemoteCommand`
 * has why the read asks for all of them.
 */
export function resolveOriginRemote(runner: Runner, directory: string): RemoteAddress | null {
	const result = runner([...originRemoteCommand(directory)]);
	if (result.code !== 0) return null;
	const first = result.stdout.split("\n")[0]?.trim();
	return first ? parseRemote(first) : null;
}
