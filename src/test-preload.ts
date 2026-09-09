/**
 * Refuses to run the suite in an environment that defeats what it tests, before any test does.
 *
 * Loaded by `bunfig.toml`'s `test.preload`, so it applies to every file without each importing it, and it
 * reads the environment once at startup — a case that sets one of these variables itself is unaffected.
 *
 * Two conditions, both of which turn a real control into a misattributed assertion failure:
 *
 * - **root**, which bypasses mode bits. A case asserting that an unreadable directory is refused passes its
 *   own guard and then fails on the assertion instead.
 * - **a redirected git environment**, which `defaultRunner` refuses per ADR-0026. Around fifty cases run real
 *   git through it, so an exported `GIT_DIR` turns the suite into fifty failures none of which name the
 *   cause. Met exactly that way by a reviewer whose shell had one set.
 *
 * Refused rather than worked around in each case: a skip spreads, and a suite that means something different
 * depending on the environment it ran in is worth less than one that declines to run.
 */
const REDIRECTED = ["GIT_DIR", "GIT_COMMON_DIR"].filter((name) => (process.env[name] ?? "") !== "");

if (process.getuid?.() === 0) {
	throw new Error(
		"this suite is not supported as root: root bypasses the mode bits some cases use to create the condition under test, so a failure there would report the wrong cause. Run it as an unprivileged user.",
	);
}

if (REDIRECTED.length > 0) {
	throw new Error(
		`this suite cannot run while ${REDIRECTED.join(" and ")} is set: the runner refuses a redirected git environment, so every case using real git would fail without naming the cause. Unset it and run again.`,
	);
}
