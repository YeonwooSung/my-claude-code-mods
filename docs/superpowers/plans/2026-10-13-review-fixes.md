# Review reliability fixes

Goal: correct the concrete reliability and analysis bugs reproduced from the supplied review.
Architecture: retain the three independent mods and their existing engine/core split. Keep conservative comparisons, ordered retryable writes and bounded similarity work.

- [x] Mask secret object keys recursively and retain inputLossy so disk inputs cannot silently replay masked values; test nested objects, arrays and ordinary fields.
- [x] Preserve failed chunk bodies and metadata, serialize retries, surface recording/degraded/not persisted in timeline, pane and status; test failure, recovery and chunk rollover.
- [x] Hash complete outputs; use bounded samples only for lexical similarity and avoid estimating whole-output near waste from incomplete samples. Partition exact and near comparisons by context; test differing tails and cross-agent copies.
- [x] Record test identity from framework, complete normalized command and invocation cwd; compare only equal identities for base/fixedBy/improved. Unknown or lossy legacy identities do not match. Test different suites, cwd, framework and quoted arguments.
- [x] Refresh profiler summary cache by a 500ms bucket while turns/spans remain open; keep completed version cache. Test time-only changes, idle open turns, completion and profiler replacement.
- [x] Clarify snapshot-copy replay and string-only compaction checks; correct installation commands against official docs. Add independent core-test runner and CI, document adapter compatibility and four-mode performance procedure.

Verification: first observe new regression failures; run each mod's Claude test suite, standalone core suite and strict type checks. Report pre-existing engine compatibility failures separately. Full live model/UI and four-mode runtime measurements need a compatible engine and controlled model workload. License selection and cross-mod navigation are product decisions rather than bug fixes and are not inferred here.

## Verified outcome

- Node core suite: 199 passed, zero failed.
- Claude Code 2.1.292 full suites: profiler 59, Context Inspector 78, Time Machine 98; zero failed (235 total).
- Strict type checks for all mods and git diff whitespace validation passed.
- Read-only review identified and prompted additional regressions for SimHash word truncation, nested shell quoting, dirty writer retirement, and same-session step-number collisions.
- No live UI/model benchmark or inter-mod navigation implementation is claimed. LICENSE awaits owner choice.
