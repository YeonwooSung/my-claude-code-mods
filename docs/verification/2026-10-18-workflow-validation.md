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
