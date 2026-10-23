# Directory validation follow-up — 2026-10-24

Scope: both user attachments and the subsequent process, permission, import, accessor, icon, test fixture and hook-disclosure findings. Baseline: `a8e8484`. No remote publication or directory submission was performed.

## Changes and review disposition

| Finding | Resolution |
| --- | --- |
| Ten workflow adapters carried a shared dynamic process bridge, environment probe and tool replay | Generate only capabilities actually used by each feature. Decision Ledger and Assumption Tracker have no filesystem/process/environment/replay bridge. Command Shelf alone retains explicit selected-command Bash replay. Other features retain required local evidence probes. |
| Inline interpreter `node -e` presence check | Env Doctor runs the shipped `hooks/env-presence.mjs` file. It validates a variable name and returns only own-property presence, never its value. Four version probes have complete fixed argv at their process calls. |
| Remaining dynamic process arguments | Each affected README lists programs, argv templates, purposes, destinations and explicit replay behavior. Git project paths, refs and selected commands remain dynamic to preserve functionality. Time Machine documents isolated shell replay and its existing explicit confirmation and origin constraints. |
| Mod-owned `tool.call` | Removed dormant replay from nine workflows. Command Shelf documents `/shelf run`; Time Machine documents selected rerun tools and when they run. |
| Band `config.set` / settings `command.run` permission forwarding | Direct `return next(e)` with the original event, no reading/binding the downstream result. Attempted settings changes invalidate only the mod's observed display state. Tests cover deny, throw, pending requests and subsequent observations. |
| Time Machine dynamic-import findings | Replace inline `import('./store.ts').RecordingStatus` type references with a top-level static type import. Those references were type-only; no runtime loading feature is removed. |
| Time Machine writes inside installed plugin | Lexically normalize and compare the recording destination with the installed plugin path. An inside destination disables persistence and Git snapshot/cleanup operations, preserves the in-memory timeline and displays the reason. Test verifies zero `fs.write` calls while tool recording continues. |
| Missing icons | Add distinct, standalone `.claude-plugin/icon.svg` files to all 17 mods. No scripts, external references or embedded text. |
| QA environment aliases / credential inheritance | Profiler and Token Run local QA children inherit only fixed PATH/HOME/LANG metadata (plus TERM for PTY), then explicit local test settings. No blanket environment copy. |
| Credential-shaped identifiers/fixtures | Profiler span hashing takes `recordId`; Loop Detective fixture uses `checksPass`. Profiler redaction fixtures use obvious placeholders and an invalid example host. Hash output/redaction coverage remains unchanged. |
| Profiler test download/execute finding | Redactor command strings are inert test data, never executed/fetched; README and source comment explain this. No installer or downloaded executable is introduced. |
| Hooks, classic hooks, file writes, data destinations | READMEs identify owned command responses, observer effects, unchanged delegation, output data/files and network destinations. Existing dynamic exports and intentional restore of instruction/settings/build files are disclosed rather than removed. |
| Token Run test-only command / unknown call | README identifies engine-owned `$.command.run` test invocation and `$.turn.complete` synthetic completion helper. There is no other-plugin dependency. |
| Pure accessors | Keep `Profiler.isLive`, `Ledger.size`, `DurableWriter.status`, `Recorder.size`. They return local state/derived data without filesystem/network/tool effects; README explains why retained. The supplied rule explicitly permits needed accessors. |
| `tool.call` string, constructors, regex/template literal and registration notices marked “Nothing to change” | Retain normal source constructs and functionality; explain relevant false credential/command pairings. These are inventory/reviewer disclosures, not evidence of an executed command or secret transmission. |

## Behavior and remaining limits

- Model Effort Band resets observed effort to unknown on a settings attempt even if later cancelled, denied or failed. The next main model step can observe it again. Actual settings, permission rules and downstream responses are unchanged.
- Env Doctor now reports a declared empty environment variable as SET. Absence remains MISSING; values are not retained or returned. A local Node executable is still required for version/presence probes.
- A Time Machine recording destination inside the plugin keeps only memory history until an external data path is chosen and the mod reloads. The boundary check is lexical: symlinks and case aliases on case-insensitive filesystems are not canonicalized. Configure a separate normal data folder. Ordinary external-store recording, restore, compare and rerun paths remain covered by existing engine tests.
- QA launchers no longer inherit user-specific proxy, credential or arbitrary configuration environment variables. These are opt-in isolated local test launchers; normal plugin runtime is unaffected.
- Legitimate Git/ref/path arguments, configured export paths/OTLP collectors, explicit tool replay, pure accessors and test-only host calls can still produce directory inventory or human-review notices. README disclosure is the requested remedy for these findings; remote portal acceptance cannot be established with the local validator.
- No production runtime feature was removed to suppress literal-word notices. Full native Token Run terminal gameplay was not rerun in this follow-up; its launcher environment policy and engine suite were checked.

## Verification

All commands used the repository Node toolchain and Claude Code **2.1.302**. Tests finished successfully before commits; root repeated full suites after integration.

| Check | Result |
| --- | --- |
| `npm test` | 461 passed, 0 failed |
| `npm run test:adapters` | 569 passed, 0 failed across all 17 mods |
| `npm run typecheck` | All 17 projects passed |
| `npm run test:workflow` | 28 passed, 0 failed |
| `npm run check:workflow` | Generated adapters match canonical sources |
| `npm run test:privacy` | Redactor synchronization, redaction suite and privacy audit passed |
| `claude plugin validate <mod>` | All 17 passed; informational hook/capability enumeration remains |
| SVG XML/security checks | All 17 valid 64×64 SVGs; no scripts/hrefs; visually inspected contact sheet |
| Python QA launchers | Parsed successfully |
| Token Run launcher child branch | Intercepted actual `os.execve` with a fake credential canary; excluded inherited canary and kept only the fixed local dummy key/dead loopback endpoint |
| Profiler real-host permission smoke, version 0.1.7 | Automatic accept, user approval, user rejection all passed; rejection created no target file; external telemetry remained disabled |
| Independent code review | No important regression or missing workflow capability found; lexical path limitation recorded above |
| `git diff --check` | Passed |

The new environment helper was tested both as a real subprocess (set, empty, absent, invalid name) and through the actual Env Doctor adapter. Band and Time Machine changes were first observed failing their new regression checks, then passed after implementation. Engine test contexts lack the runtime plugin metadata property; the Time Machine test therefore derives its fixture directory from its own module URL.

Local logs/artifacts were written under `/tmp/directory-*`, `/tmp/time-plugin-dir-green.log` and `/tmp/mod-icons-preview.png`; they are not shipped with plugins. Commit history separates permission forwarding, Time Machine boundaries/imports, workflow capabilities, each source/QA disclosure group, icons and this verification record.
