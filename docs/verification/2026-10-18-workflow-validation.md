# Expanded workflow validation — 2026-10-18

Baseline: clean main at 8c959f8; core suite 387/387.

## Unit 1 — Per-feature boundaries

Added 24 tests across all ten new mods. First focused run: 65 tests, 58 passed, 7 failed. Fixed only demonstrated defects:

- Preserve repeated spaces in literal Scope Guard / Review Queue paths.
- Invalid explicit exit codes stay UNKNOWN even with completed-looking Bash streams.
- Help/config/collection/list-only commands are not verification runs.
- Reject primitive/array package manifests and malformed lock entries as incomplete evidence.
- Compare lock metadata independent of object-key insertion order.

Passing added cases also cover import variants, unreadable/oversized scans, retained-record caps, stable identifiers, selective filtering, permission-aware quoted-cwd replay, evidence/history retention, missing Git/environment data, zero-major semver boundaries and regroup/unmark behavior.

Verification: 411 core tests passed; all engine suites and all 17 TypeScript projects passed.

## Unit 2 — Real Git, filesystem and shared evidence

Added 13 tests (7 real-Git/filesystem, 5 shared runtime, 1 Command Shelf privacy). First runs reproduced 8 failures. Fixes:

- Hash staged diffs separately from the HEAD-to-working diff, preventing identical working files from concealing different index contents.
- Dirty submodule diffs are UNKNOWN; explicit ignore-submodules=none prevents default configuration from concealing their dirty state.
- Preserve the Git root's trailing spaces by removing only its final output newline.
- Do not dereference symlinks when collecting untracked snapshots or review evidence; return unknown/incomplete instead.
- Treat filesystem root as a valid relative-path base.
- Mask quoted multiline credentials before splitting their context; omit oversized sensitive values whole so continuation tails cannot leak.

Passing new cases also verify actual spaced renames/deletions, ignored secret-file exclusion, the untracked-file cap, stderr truncation and unreadable-file evidence. These tests create only disposable local Git repositories; no network or remote changes.

Verification: 424 core tests passed; all engine suites and all 17 TypeScript projects passed. Shared runtime copies synchronized.

## Unit 3 — Lifecycle, persistence and combined operation

Added 13 controlled-host lifecycle tests, two actual Claude-engine adapter tests and three regressions from independent review (18 tests in this unit).

The controlled host composes all ten production adapters in both registration orders, with engine-like structured-clone store boundaries and explicit dispatch origins. It verifies distinct command registration, exactly-once tool forwarding, verification freshness and cross-mod observations. Other cases cover concurrent unique commands, read/write outages and recovery, malformed-record reset, thrown/denied tools, identity failures, changes while awaiting store load, isolation between folders with the same session ID, and unrelated Bash completion during replay.

First lifecycle run: 12 tests, 9 passed / 3 failed. Actual engine tests independently reproduced the read-only-report failure. Fixes:

- Persist only changed state, so read-only reports remain available during a write outage. Explicit reset still forces a durable write and reports failures.
- Skip observation entirely for command-only mods, avoiding useless storage calls on every tool.
- Skip only the mod's own replay dispatch, using engine origin metadata; unrelated concurrent completions are retained.

Independent read-only review found two additional pre-existing gaps. Three new failing tests reproduced them before fixes:

- Oversized quoted --user/-u, URL-userinfo and MySQL credential values must be omitted whole rather than exposing continuation tails. Any quoted/escaped oversized line is now handled conservatively.
- Vitest list-only subcommands are excluded from Verify Board and Handoff Pack verification evidence.

All findings were fixed by RED→GREEN regression tests. No deferred findings.

### Final verification

Environment: Node 22.19.0; Claude Code 2.1.302.

| Check | Result |
|---|---|
| Added distinct tests | 55: 53 core/integration + 2 engine-only |
| `npm test` | 440 passed, 0 failed (baseline 387) |
| `npm run test:adapters` | 17 suites; 540 passed, 0 failed (baseline 505) |
| `npm run test:workflow` | 28 passed: real-Git and controlled-host adapter tests |
| `npm run typecheck` | All 17 mod projects passed |
| `npm run test:privacy` | Shared masking corpora and existing real-Git privacy audit passed |
| `npm run check:workflow` | All standalone runtime/adapter copies match canonical sources |
| `claude plugin validate .` | Passed |
| `git diff --check` | Clean |

### Review boundaries and rulings

- Combined operation is a controlled-host test of real adapters, plus individual actual-engine tests; actual multi-plugin engine co-loading and live UI/pixel verification remain separate. Cost of this limit: combined host-specific integration or visual issues may remain.
- Arbitrary project-defined npm scripts are not interpreted. Reports describe observed check evidence, not proof of test coverage. Cost: a successful project script can still be semantically incomplete.
- Filesystem evidence reads are not atomic against adversarial concurrent changes. Dirty submodules and symlink targets remain unknown/incomplete rather than claiming complete snapshots.
- Broader unchanged feature behavior was outside this targeted expansion; the existing full regression and privacy suites were rerun.
- Source fixes were limited to defects demonstrated by failing tests, with three logical commits on the already-merged main checkout as requested by the continuing unit-commit workflow.
