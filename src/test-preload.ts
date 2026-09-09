/**
 * Refuses to run the suite as root, before any test does.
 *
 * Loaded by `bunfig.toml`'s `test.preload`, so it applies to every file without each importing it.
 *
 * root bypasses mode bits, and a case asserting that an unreadable directory is refused passes its own
 * guard and then fails on the assertion instead — a real control turned into a misattributed failure.
 *
 * Refused rather than worked around case by case: a skip spreads, and a suite that means something
 * different depending on where it ran is worth less than one that declines to run.
 */
if (process.getuid?.() === 0) {
	throw new Error(
		"this suite is not supported as root: root bypasses the mode bits some cases use to create the condition under test, so a failure there would report the wrong cause. Run it as an unprivileged user.",
	);
}
