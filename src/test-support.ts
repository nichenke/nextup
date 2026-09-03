import type { CommandResult, Runner } from "./runner";

export function fakeRunner(result: CommandResult): Runner {
	return () => result;
}

export function routedRunner(routes: Record<string, CommandResult>): Runner {
	return (argv) => routes[argv.join(" ")] ?? { code: 1, stdout: "", stderr: "" };
}
