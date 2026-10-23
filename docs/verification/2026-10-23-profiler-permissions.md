# Agent Profiler 0.1.6 permission-observation verification

Date: 2026-10-23 (Asia/Seoul). Engine: Claude Code 2.1.302.

## Result and behavior

Permission outcomes are observed through `telemetry.log` filtered to `collector`. There is no `tool.check`, `classic.PreToolUse` or `classic.PermissionRequest` registration. The observer returns `next(e)` unchanged, does not enable an exporter, and retains only fixed decision/source/classifier enums plus the timestamp associated with a recorded tool-use ID. Arbitrary telemetry attributes and identity fields are not copied into profiler state or OTLP.

Final `accept`/`reject` is distinct from the former intermediate `allow`/`ask`/`deny`. Completed calls with an identifiable user/classifier source and execution evidence (or confirmed rejection) receive an estimated pre-decision wait. Other waits remain unclassified. Reports show unavailable or partial coverage instead of claiming missing values are zero. Reports and OTLP share one timing calculation. A confirmed rejection has zero execution and no execution span.

OTLP adds `agent_profiler.permission_decision`, `permission_source`, `permission_classifier`, `permission_wait_ms` and `permission_wait_kind` when available. It no longer emits the old `agent_profiler.permission` verdict attribute. Runtime and manifest version are both 0.1.6.

## Checks

| Check | Result |
|---|---|
| `npm test` | 458 passed, 0 failed |
| `npm run test:adapters` (final serial run) | 562 passed, 0 failed across all 17 mods |
| Agent Profiler engine suite | 81 passed, 0 failed |
| `npm run typecheck` | passed, all 17 mods |
| `npm run test:privacy` | passed |
| `npm run check:workflow` | passed |
| `claude plugin validate` for every marketplace mod | 17 passed |
| Real SDK-host permission smoke test | all 3 cases passed, telemetry export disabled |
| Independent implementation review | no blocking findings; late-export limitation documented |

An earlier engine-suite run concurrent with core tests/typechecking had one timing failure: `summarize over 20k spans in many turns stays fast` measured 212ms against its 200ms limit. The same test passed in an isolated run (130.58ms including setup), and the complete final engine suite passed when run without competing heavy checks. The threshold and performance test were not relaxed.

## Regression evidence

- Before the implementation, new core/report cases failed because the result-observation API and unavailable display were absent.
- With the collector observer temporarily removed, the two adapter tests failed on missing report coverage. Restoring it made both pass. This validates the actual registration-to-report/export path, rather than only a direct call to the core model.
- A confirmed rejection initially still generated an execution span; its regression case failed, then passed after the export change.
- Cases cover unrelated/malformed records, invalid and out-of-window timestamps, unknown IDs, duplicates, fixed normalization of unknown source/classifier values, missing duration evidence, partial coverage, auto-classifier metadata, late observations and subagent tool IDs.

## Real-engine smoke test

```sh
python3 agent-profiler/qa/permission_smoke.py \
  --claude-bin /path/to/claude \
  --artifacts /tmp/profiler-permission-smoke
```

The standard-library driver uses a temporary config and profiler copy; only the fallback output directory is redirected into the fixture. Provider configuration uses a placeholder credential and a refused loopback URL. No model request or paid API call is made. Exporters are disabled. The host approves only an exact temporary Write input, after a 300ms delay, or rejects it. `/profile-export` is submitted as a separate command after the tool command finishes; nested command execution inside a command hook is prohibited by the engine.

The final release run produced:

| Case | Final result / source | Estimated prefix | File outcome |
|---|---|---|---|
| Automatic Read | accept / config | unavailable | existing fixture read |
| Host-approved Write | accept / user_temporary | 319ms | file created |
| Host-rejected Write | reject / user_reject | 322ms | file absent, no execution span |

Host request IDs matched exported tool IDs. Exported version matched the manifest. The estimates include checks, dispatch and hooks; they are not exact human response durations. Only local `result.json` summary output is retained after temporary fixture cleanup.

## Remaining boundaries

- Final results cannot reconstruct every intermediate ask. A bare config/hook source remains ambiguous. Hosted sessions may report a saved grant with a user-related source; it need not mean a new prompt appeared.
- A valid late decision can update reports and a subsequent full snapshot. Automatic batches exported before it arrived are not rewritten. The observed live smoke path delivered decisions before tool return.
- The new live probe does not exercise native terminal/Desktop permission dialogs, actual auto-classifier model requests, cancellation or older engine versions. Classifier parsing/calculation is covered with controlled core events.
- Local CLI validation is not a rerun of the remote directory's validator; no remote acceptance is claimed.
