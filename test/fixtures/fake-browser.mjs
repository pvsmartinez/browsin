/**
 * Fake browser for the suite. A bare `sleep` used to stand in for a browser in
 * state.json, but gc now verifies via ps that a pid really runs
 * `--user-data-dir=<session>/profile` before killing it (a state pid can be
 * reused by an unrelated process — killing blind is worse than waiting a run).
 * This process carries the flag in its real argv, so the identity check kills
 * it without any real Chrome being involved. Runs until signaled.
 */
setInterval(() => {}, 1e6);
