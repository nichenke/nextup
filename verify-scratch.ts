import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner } from "./src/runner";
import { WorktreeError, ensure } from "./src/worktree";

const READER = {
	ref: { tracker: "github" as const, repo: "example/repo", host: null, key: "8" },
	title: "Reader",
	labels: [] as string[],
};

function newRepo(label: string): { repo: string; base: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), `nextup-${label}-`)));
	const repo = join(base, "primary");
	mkdirSync(repo, { recursive: true });
	const run = (...argv: string[]) => {
		const r = defaultRunner(["git", "-C", repo, ...argv]);
		if (r.code !== 0) throw new Error(`${argv.join(" ")} -> ${r.code} ${r.stderr}`);
		return r;
	};
	defaultRunner(["git", "init", "-b", "main", repo]);
	run("config", "user.email", "a@b.c");
	run("config", "user.name", "A");
	run("commit", "--allow-empty", "-m", "root");
	mkdirSync(join(repo, "src"), { recursive: true });
	return { repo, base };
}

function attempt(label: string, fn: () => unknown): void {
	try {
		const out = fn();
		console.log(`${label}: OK ${JSON.stringify(out)}`);
	} catch (e) {
		if (e instanceof WorktreeError) console.log(`${label}: WorktreeError kind=${e.kind} msg=${e.message}`);
		else console.log(`${label}: THREW ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
	}
}

const which = process.argv[2];

if (which === "c5") {
	const { repo, base } = newRepo("c5");
	// Caller-supplied absolute root under $TMPDIR, NOT realpath'd — exactly what a launcher passing
	// `${TMPDIR}/trees` would hand over.
	const raw = `${process.env.TMPDIR}trees`;
	attempt(`c5 root=${raw}`, () => ensure({ runner: defaultRunner, repo, ticket: READER, root: raw }).kind);
	attempt("c5 root=/tmp/nextup-c5-trees", () =>
		ensure({ runner: defaultRunner, repo, ticket: READER, root: "/tmp/nextup-c5-trees" }).kind,
	);
	// Control: the same physical place, spelled resolved.
	attempt("c5 root=resolved", () => ensure({ runner: defaultRunner, repo, ticket: READER, root: join(base, "trees") }).kind);
}

if (which === "c7") {
	for (const root of [".git", ".git/worktrees", "src", "..", "   ", "", ".", "./"]) {
		const { repo } = newRepo("c7");
		attempt(`c7 root=${JSON.stringify(root)}`, () => {
			const o = ensure({ runner: defaultRunner, repo, ticket: READER, root });
			const status = defaultRunner(["git", "-C", o.path, "status", "--short"]);
			const primaryStatus = defaultRunner(["git", "-C", repo, "status", "--short"]);
			return {
				kind: o.kind,
				path: o.path.replace(repo, "<repo>"),
				statusInWorktree: status.stdout.trim().split("\n").slice(0, 8),
				statusInPrimary: primaryStatus.stdout.trim().split("\n").slice(0, 8),
			};
		});
	}
}

if (which === "c6") {
	// The race: both sessions read no registration and no branch, then the winner's add lands first.
	// Modelled by interposing on the loser's `worktree add` — the winner runs at exactly that instant.
	const { repo, base } = newRepo("c6");
	const winnerRoot = join(base, "winner");
	const stage = process.argv[3]; // "branch" = winner only cut the branch; "full" = winner finished its add
	const racing = (argv: string[]) => {
		if (argv.includes("add")) {
			if (stage === "branch") {
				const r = defaultRunner(["git", "-C", repo, "branch", "feature/reader-8"]);
				console.log(`winner cut branch -> ${r.code} ${r.stderr.trim()}`);
			} else {
				const r = defaultRunner(["git", "-C", repo, "worktree", "add", join(repo, ".worktrees", "reader-8"), "-b", "feature/reader-8"]);
				console.log(`winner added worktree -> ${r.code} ${r.stderr.trim()}`);
			}
		}
		return defaultRunner(argv);
	};
	attempt(`c6 loser stage=${stage}`, () => ensure({ runner: racing, repo, ticket: READER, root: winnerRoot === "" ? null : undefined }).kind);
	// And the re-run, with no interposition: does it heal?
	attempt("c6 re-run", () => ensure({ runner: defaultRunner, repo, ticket: READER }).kind);
}
