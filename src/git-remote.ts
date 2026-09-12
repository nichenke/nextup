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

/** The scopes ADR-0042 puts in contract: what this checkout configures, rather than what it inherits. */
const CHECKOUT_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);

/**
 * The origin remote of the checkout at `directory`, or null where there is none to read. A null is turned
 * into a refusal by ADR-0040's resolver.
 *
 * @throws nothing; a read this cannot attribute answers null rather than guessing.
 */
export function resolveOriginRemote(runner: Runner, directory: string): RemoteAddress | null {
	const result = runner([...originRemoteCommand(directory)]);
	if (result.code !== 0) return null;
	const url = checkoutOriginUrl(result.stdout);
	return url === null ? null : parseRemote(url);
}

/**
 * The first URL this checkout configures for itself, from the read's NUL-delimited `<scope>\0<value>\0` pairs.
 *
 * Not "the URL git fetches from", which is a different value whenever an out-of-contract scope also sets one:
 * git takes the first across every scope, so a global file wins there. Answering differently is the decision,
 * not a divergence to fix.
 *
 * Empty values are skipped because git drops them from a remote — measured, `remote get-url --all` reports only
 * the non-empty ones — so the first non-empty value is the one the checkout is actually addressed by.
 *
 * Exported for the tests that run this against real git: those remotes are filesystem paths, which `parseRemote`
 * is right to refuse, so they cannot be asserted through `resolveOriginRemote`.
 */
export function checkoutOriginUrl(stdout: string): string | null {
	const fields = stdout.split("\0");
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const value = fields[index + 1] as string;
		if (CHECKOUT_SCOPES.has(fields[index] as string) && value !== "") return value;
	}
	return null;
}
