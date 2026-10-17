# assumption-tracker design

## Intent
Persist assumptions as unverified, confirmed or refuted and require evidence for resolved states.

## Deliverable
Standalone installable local Claude Code mod with `/assume` help and report commands, persistent state isolated by project and session, and observable tool integration where applicable. Use TypeScript pure analysis plus a small engine adapter. No network calls, automatic package installation, source rewrites or automatic command replay.

## First release boundaries
Git projects; bounded snapshots and reports must expose incomplete evidence. Blast Radius supports static relative JS/TS imports, not a full language server. Env Doctor supports a documented conservative semver subset and reports unsupported expressions as unknown. Dependency Lens supports npm package-lock v2/v3. Decisions and assumptions are explicit user entries, not inferred facts. Review Queue groups files by purpose, not individual hunks.

## Constraints
- Node >=22.19.0 for repository tests.
- Standalone plugin packaging: no imports from sibling mods.
- Observer failures must not fail or rerun the underlying tool.
- Mask obvious secrets and terminal control characters before persistence/display.
- Bound retained items and filesystem scans; mark unknown/incomplete results.

## Review focus
Missing evidence; illegal transitions; stable identifiers; masked references; persistence failure.

## Authorization
User requested implementation of ideas 1–10 sequentially, with TDD and commits per unit. This design makes routine first-release implementation choices explicit; proceed without another approval round.
