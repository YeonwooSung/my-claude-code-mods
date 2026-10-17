# My Claude Code Mods

[Claude Code Mods Overview](https://code.claude.com/docs/en/plugins/mods/overview) [Create Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/create)

## Mods

- [agent-profiler](agent-profiler/README.md): shows where a session's time goes (model wait, tools, subagents, re-reads) and exports OTLP traces for Jaeger/Tempo.
- [context-inspector](context-inspector/README.md) ([한국어](context-inspector/README_KR.md)): analyzes context waste in Claude sessions, including what fills the window, re-reads, near-duplicate outputs, and what compaction kept, providing advice.
- [time-machine](time-machine/README.md) ([한국어](time-machine/README_KR.md)): records every tool call on a branching timeline with shadow-git snapshots, so you can see the files as they were at any step, explain which edit broke a test, restore, branch, compare runs and re-run steps.
- [loop-detective](loop-detective/README.md) ([한국어](loop-detective/README_KR.md)): detects repeated Bash failures and edit/retry cycles, with evidence, investigation prompts, a live case pane and bounded history.
- [pin-memo](pin-memo/README.md) ([한국어](pin-memo/README_KR.md)): pins memos and clickable todos above the input, restoring them when the same folder/session is resumed.
- [model-effort-band](model-effort-band/README.md) ([한국어](model-effort-band/README_KR.md)): shows the selected model and observed main-thread effort in a colored band above the prompt.
- [token-run](token-run/README.md) ([한국어](token-run/README_KR.md)): a fully local ASCII runner for request failures and short breaks, with jump controls and a saved best score.

## Installation

Use a current Claude Code CLI with Mods support (mods are enabled by default from **2.1.287**). Token Run has been verified in real terminal sessions with **2.1.296 and 2.1.301**; see each mod's README for its tested versions. Time Machine also requires `git` on your PATH.

### Install all mods at once

Run this entire block in your terminal (macOS/Linux, Bash or Zsh). It adds the marketplace and installs all seven mods for your user account, so they are available across projects. No repository clone or `npm install` is needed.

```sh
(
  set -eu
  claude plugin marketplace add YeonwooSung/my-claude-code-mods

  for mod in agent-profiler context-inspector time-machine loop-detective pin-memo model-effort-band token-run; do
    claude plugin install "${mod}@my-claude-code-mods" --scope user
  done
)
```

If you have already added the marketplace, omit the `claude plugin marketplace add` line. The block stops on the first failed command; resolve that error before installing the remaining mods.

### Install individual mods

Add the marketplace once in your terminal:

```sh
claude plugin marketplace add YeonwooSung/my-claude-code-mods
```

Then run only the install commands for the mods you want:

```sh
claude plugin install agent-profiler@my-claude-code-mods --scope user
claude plugin install context-inspector@my-claude-code-mods --scope user
claude plugin install time-machine@my-claude-code-mods --scope user
claude plugin install loop-detective@my-claude-code-mods --scope user
claude plugin install pin-memo@my-claude-code-mods --scope user
claude plugin install model-effort-band@my-claude-code-mods --scope user
claude plugin install token-run@my-claude-code-mods --scope user
```

Alternatively, run these slash commands **inside a Claude Code session**, replacing `pin-memo` with any mod name listed above:

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install pin-memo@my-claude-code-mods
```

The shell commands above explicitly use `--scope user`. For a project-specific installation, use `--scope project` (shared through the project's settings) or `--scope local` (only you in that project).

### Load and verify

Start a new Claude Code session after installation, or run `/reload-plugins` in an already open session. Run `/plugin` to check the loaded mods and manage or disable individual ones. See the [official Mods installation documentation](https://code.claude.com/docs/en/plugins/mods/overview#install-or-update-a-mod) and each mod's README under [Mods](#mods) for commands and configuration.

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
| Token Run engine suite | Engine tests: 2.1.296/299/300/301; real terminal 2.1.296/301 solo + 2.1.301 all seven mods; Desktop GUI unverified |
| Early-access Claude Code 2.1.280 | Profiler works; Context Inspector lacks `session.append`, and Time Machine's per-test options are ignored |
| Live terminal/desktop UI and simultaneous mods | Requires a separate interactive integration run; unit suites do not establish UI compatibility |

For a controlled overhead comparison, use a disposable representative large repository at one fixed commit and the same Claude engine/model/permission settings. Run the same workload under four configurations: no mods, profiler only, Time Machine only, and all three. Load mods explicitly with `--plugin-dir` while other installed plugins are disabled; reset files and recorder stores outside the timed interval. Use a warm-up and at least five measured repetitions per configuration, alternate run order, and record wall time, tool-call count, model tokens and snapshot average. Include no-change mutating calls and actual edits. Report median/p95 and separate model latency from snapshot/hook time. The existing 20k-span/item tests bound analysis cost but do not measure combined engine overhead; no four-mode performance result is claimed here.
