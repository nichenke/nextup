import { spawnSync } from "bun";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Exec = (argv: string[]) => CommandResult;

export const defaultExec: Exec = (argv) => {
	try {
		const result = spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe" });
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (err) {
		return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
};
