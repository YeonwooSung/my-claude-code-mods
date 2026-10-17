# Workflow Mod Validation Expansion

> Execute sequentially with TDD. Existing authorization covers additional tests, necessary bug fixes and commits per unit.

**Goal:** Strengthen the ten new mods against realistic boundary inputs, incomplete evidence and shared-engine failures.

**Architecture:** Add tests to existing per-mod feature/adapter suites and the Node real-Git integration suite. Fix only defects demonstrated by new failing tests. Keep independently packaged runtime copies synchronized.

**Review focus:** False PASS/REVIEWED results; exact path identity; failed persistence changing saved data; interrupted tool forwarding; combined hook behavior; bounded state and reports.

## Task 1 — Feature boundaries

- [x] Add tests for exact paths, literal scopes and denied writes; import resolution/scan limits; history caps and stable identifiers; semver/tool evidence; malformed dependency data; review regroup/unmark behavior.
- [x] Run focused suites; record any failing assertions before implementation.
- [x] Fix demonstrated boundary defects, then run core, relevant engine suites and typechecking.
- [x] Commit feature tests and verified fixes.

## Task 2 — Real Git and shared evidence

- [x] Extend actual temporary-Git tests for rename/deletion, binary content, submodule/working-tree evidence, incomplete snapshots and exact filenames.
- [x] Add conservative outcome/path/masking cases to runtime tests.
- [x] Reproduce any false confidence, make the smallest fix, sync standalone copies, and verify.
- [x] Commit Git/evidence regressions and fixes.

## Task 3 — Adapter lifecycle and combined operation

- [x] Test concurrent commands; failed reads/writes and recovery; identity failure/change; reset recovery; thrown tools; read-only command behavior.
- [x] Compose the ten real adapters against one controlled host, verifying command registration and exactly-once tool execution. Distinguish this from actual engine co-loading or live pixel verification.
- [x] Run all core tests, all engine suites, all typechecks, privacy checks, synchronization and manifest validation.
- [x] Record counts, known limits and commit the final validation unit.
