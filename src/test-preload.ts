/**
 * Refuses to run the suite as root, before any test does.
 *
 * Root defeats the controls several tests rely on: `chmodSync(path, 0o000)` does not stop root reading a
 * directory, so a case asserting that an unreadable directory is refused passes its own guard and fails on
 * the assertion instead — a real failure reported as a wrong one. Rather than skipping those cases under
 * root, which spreads and leaves a suite that means something different depending on who ran it, running as
 * root is unsupported and says so here.
 *
 * Loaded by `bunfig.toml`'s `test.preload`, so it applies to every file without each importing it.
 */
if (process.getuid?.() === 0) {
	throw new Error(
		"this suite is not supported as root: root bypasses the mode bits some cases use to create the condition under test, so a failure there would report the wrong cause. Run it as an unprivileged user.",
	);
}
