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
 * The config scopes whose value is this checkout's own statement of which repository it is.
 *
 * `local` is `.git/config` and every file it names, since git labels an included value by the file that
 * included it; `worktree` is a linked worktree's own `config.worktree`. Everything else git can label —
 * `global`, `system`, `command` — is configuration this checkout did not ask for, which is the whole thing
 * ADR-0041 refuses.
 */
const CHECKOUT_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);

/**
 * The origin remote of the checkout at `directory`, or null where there is none to read. A null is turned
 * into a refusal by ADR-0040's resolver.
 *
 * The first URL this checkout configures, which is the one git takes: `--show-scope` emits values in scope
 * order and, within a scope, in file order, so the first line bearing a `CHECKOUT_SCOPES` label is the value
 * `git fetch` would use — measured, including where a worktree config supplies a second one.
 *
 * An empty value is left to `parseRemote` to refuse rather than skipped. A remote whose first URL is empty is
 * a configuration this cannot read a repository out of, and refusing is the answer ADR-0041 gives for those.
 */
export function resolveOriginRemote(runner: Runner, directory: string): RemoteAddress | null {
	const result = runner([...originRemoteCommand(directory)]);
	if (result.code !== 0) return null;
	const url = checkoutOriginUrl(result.stdout);
	return url === null ? null : parseRemote(url);
}

/**
 * The first `<scope>\t<value>` line whose scope is this checkout's, as its value.
 *
 * A line carrying no tab is skipped rather than read as a value: `--show-scope` labels every line it emits,
 * so one without a label is not a value this can attribute, and attributing it to the checkout is the one
 * mistake that matters here.
 *
 * Exported so the tests that run this against real git assert the rule itself rather than a second copy of
 * it — those remotes are filesystem paths, which `parseRemote` is right to refuse, so they cannot go through
 * `resolveOriginRemote`.
 */
export function checkoutOriginUrl(stdout: string): string | null {
	for (const line of stdout.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab !== -1 && CHECKOUT_SCOPES.has(line.slice(0, tab))) return line.slice(tab + 1);
	}
	return null;
}
