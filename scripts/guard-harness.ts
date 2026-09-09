import { spawnSync } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "../src/runner";

const script = join(import.meta.dir, "check-identifiers.sh");

/**
 * Runs `check-identifiers.sh` over `contents` in a throwaway git repository, and returns the finished
 * process. The repository is not incidental: the guard reads `git ls-files`, so an untracked file is
 * invisible to it and an unstaged fixture would report a pass it never earned.
 *
 * Shared by the guard's own tests and by `src/recording-identifiers.test.ts`, which asserts that redaction
 * leaves nothing this rejects. ADR-0024 has why that assertion must run the real guard rather than a copy of
 * its pattern.
 *
 * @throws Error when `git init` or `git add` fails, which would otherwise pass as a clean scan.
 */
export function runGuardOn(contents: string) {
	const dir = mkdtempSync(join(tmpdir(), "nextup-guard-"));
	// Removed even when setup throws: each call creates a git repository, and leaving them behind had
	// accumulated 3502 directories and most of a gigabyte of temp space before anyone looked.
	try {
		writeFileSync(join(dir, "fixture.md"), contents);
		for (const cmd of [
			["git", "init", "-q"],
			["git", "add", "fixture.md"],
		]) {
			// Scrubbed, or an exported GIT_DIR aims `git init` and `git add` at another repository and the
			// fixture is never staged where the guard looks. `src/runner.ts` owns which names go.
			const setup = spawnSync({ cmd, cwd: dir, env: gitEnvironment(process.env).env });
			if (setup.exitCode !== 0) {
				throw new Error(`fixture setup failed: ${cmd.join(" ")}`);
			}
		}
		// Explicitly, or a case that sets a variable cannot reach the guard — `src/runner.test.ts` has why an
		// inherited child cannot see one. Whole, for the reason in ADR-0029.
		return spawnSync({ cmd: ["bash", script], cwd: dir, env: { ...process.env } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
