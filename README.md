# My Claude Code Mods

[Claude Code Mods Overview](https://code.claude.com/docs/en/plugins/mods/overview) [Create Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/create)

## Mods

- [agent-profiler](agent-profiler/README.md): shows where a session's time goes (model wait, tools, subagents, re-reads) and exports OTLP traces for Jaeger/Tempo.
- [context-inspector](context-inspector/README.md) ([한국어](context-inspector/README_KR.md)): analyzes context waste in Claude sessions, including what fills the window, re-reads, near-duplicate outputs, and what compaction kept, providing advice.
- [time-machine](time-machine/README.md) ([한국어](time-machine/README_KR.md)): records every tool call on a branching timeline with shadow-git snapshots, so you can see the files as they were at any step, explain which edit broke a test, restore, branch, compare runs and re-run steps.
- [loop-detective](loop-detective/README.md) ([한국어](loop-detective/README_KR.md)): detects repeated Bash failures and edit/retry cycles, with evidence, investigation prompts, a live case pane and bounded history.
- [pin-memo](pin-memo/README.md) ([한국어](pin-memo/README_KR.md)): pins memos and clickable todos above the input, restoring them when the same folder/session is resumed.
- [model-effort-band](model-effort-band/README.md) ([한국어](model-effort-band/README_KR.md)): shows the selected model and observed main-thread effort in a colored band above the prompt.

## Development

Use Node 22.19.0 or later. Dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm test                  # core logic, no Claude Code installation/account required
CLAUDE_BIN=/path/to/claude npm run test:adapters  # full engine suites, including adapters
npm run typecheck         # requires engine-generated declarations in each .claude-plugin/types
```

`npm test` maps the core tests' `claude-code/testing` import to Node's test runner and Jest's `expect`; it does not emulate engine events. Files run sequentially so the existing performance assertions do not compete with other test processes. CI runs this independent core suite. Engine type declarations are generated locally and remain untracked; use the declarations belonging to the engine under test. See each mod's development instructions for generation/setup.

| Validation target | Compatibility |
|---|---|
| Node core tests | Node 22.19.0; TypeScript transformation flag required |
| Original three engine test suites | Verified with Claude Code 2.1.292 |
| Pin Memo engine suite | Verified with Claude Code 2.1.292; render trees and Button presses on terminal/Desktop |
| Loop Detective engine suite | Verified with Claude Code 2.1.280; TypeScript checks use local 2.1.292 declarations |
| Model Effort Band engine suite | Verified with Claude Code 2.1.292; terminal/Desktop render trees, live pixels unverified |
| Early-access Claude Code 2.1.280 | Profiler works; Context Inspector lacks `session.append`, and Time Machine's per-test options are ignored |
| Live terminal/desktop UI and simultaneous mods | Requires a separate interactive integration run; unit suites do not establish UI compatibility |

Installation uses `plugin@marketplace` as described in the [official Mods documentation](https://code.claude.com/docs/en/plugins/mods/overview). Add this marketplace once, then install the desired mod using its README.

For a controlled overhead comparison, use a disposable representative large repository at one fixed commit and the same Claude engine/model/permission settings. Run the same workload under four configurations: no mods, profiler only, Time Machine only, and all three. Load mods explicitly with `--plugin-dir` while other installed plugins are disabled; reset files and recorder stores outside the timed interval. Use a warm-up and at least five measured repetitions per configuration, alternate run order, and record wall time, tool-call count, model tokens and snapshot average. Include no-change mutating calls and actual edits. Report median/p95 and separate model latency from snapshot/hook time. The existing 20k-span/item tests bound analysis cost but do not measure combined engine overhead; no four-mode performance result is claimed here.
