import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-identifiers.sh");

/**
 * Runs `check-identifiers.sh` over `contents` in a throwaway git repository, and returns the finished
 * process. The repository is not incidental: the guard reads `git ls-files`, so an untracked file is
 * invisible to it and an unstaged fixture would report a pass it never earned.
 *
 * Shared by the guard's own tests and by `src/recording-identifiers.test.ts`, which asserts that redaction
 * leaves nothing this rejects. That assertion has to run the real guard: a copy of its pattern in
 * TypeScript agreed with the code it was transcribed from while both disagreed with the guard, which is how
 * an escaped-slash URL passed redaction with its host intact.
 *
 * @throws Error when `git init` or `git add` fails, since a fixture that was never staged would otherwise
 * be scanned as an empty repository and pass.
 */
export function runGuardOn(contents: string) {
	const dir = mkdtempSync(join(tmpdir(), "nextup-guard-"));
	writeFileSync(join(dir, "fixture.md"), contents);
	for (const cmd of [
		["git", "init", "-q"],
		["git", "add", "fixture.md"],
	]) {
		const setup = spawnSync({ cmd, cwd: dir });
		if (setup.exitCode !== 0) {
			throw new Error(`fixture setup failed: ${cmd.join(" ")}`);
		}
	}
	return spawnSync({ cmd: ["bash", script], cwd: dir });
}
