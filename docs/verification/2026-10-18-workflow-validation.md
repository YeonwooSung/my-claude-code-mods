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
