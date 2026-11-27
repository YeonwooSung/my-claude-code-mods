# Command Shelf observation persistence fix

## Diagnosis

The reported `/shelf list` output contains existing history through ID 8242. This establishes that history was readable; it does not identify the exception behind subsequent failed observations. The old adapter discarded that exception and displayed the same toast on every tool call.

A reproducible failure exists independently of the host store: Command Shelf retained up to 200 commands of up to 4,000 characters each, but the shared adapter rejects state above 256 KiB of JSON characters. A synthetic near-limit history ending at ID 8242 rejects the next command. An independent 100-command fixture produces roughly 355 KiB. These are synthetic fixtures, not copies of the user's command history. The initial regression run had four expected failures.

The installed local cache inspected during diagnosis was version 0.1.0, while this repository started at 0.1.3. Its inspected store did not prove an active quota or corruption failure, and it cannot be assumed to be the exact failing session. The original session's underlying exception remains unconfirmed. No installed cache, plugin inventory or user store was modified.

## Changes

- Bound shelf history to 200 records and 240 KiB of UTF-8 state; evict oldest entries and preserve retained IDs. Labelling preserves the target entry. Oversized legacy history can recover on a duplicate successful command.
- Avoid store access for tools other than Bash and for unsuccessful or ineligible commands.
- Categorize host read/write errors using fixed messages; never echo raw exceptions that may contain command history or credentials.
- Warn once during continuous observation failures; show the latest safe diagnostic through the plugin command. A successful write clears the warning. Do not erase other sessions to recover a full plugin store.
- Ignore failures belonging to an old session. Track successful-write generations so a delayed failure cannot reinstate a warning after storage recovers.
- Regenerate all ten workflow adapters from the canonical template; bump their patch versions to 0.1.4.

The per-plugin host quota can still be exhausted by multiple sessions. This fix reports that condition rather than deleting user data automatically. Repository changes require a later plugin update/reload to affect the installed cache; this task stops at a local main commit.

## Validation

- Core suite: 539 passed, 0 failed.
- Claude Code 2.1.302 engine suites: all 17 plugins, 607 passed, 0 failed.
- TypeScript checks for all 17 plugins, generated-adapter consistency and privacy checks passed.
- Regressions cover near-limit ID 8242 history, UTF-8 size, stable IDs, legacy duplicate compaction, ignored tools/failed commands, warning suppression/recovery, safe error categories and session/concurrent-write warning races.
- Independent review identified the delayed-failure race; it was corrected and a deterministic regression added. No live UI or installed-cache update was performed.
