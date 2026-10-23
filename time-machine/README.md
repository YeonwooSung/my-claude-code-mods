# Time Machine — a time machine for agents

**English** | [한국어](README_KR.md)

When an agent changes several files and ends up somewhere wrong, a Git diff only tells you "what changed".
Time Machine records **in what order, which tool call, on which file state, produced which result**, and lets you go back to any step to see the files and tool calls as they were then.
It also supports tracing causality between file edits and test failures, restoring a point in time, branching, comparing two runs, and re-running a step with the same input.

```
Session #184
├── ① Read auth.py
├── ② Grep JWT
├── ③ Edit auth.py            └── snapshot A
├── ④ Bash pytest             └── 3 failed
├── ⑤ Edit middleware.py      └── snapshot B
└── ⑥ Bash pytest             └── 12 passed   (fixed by ⑤)
```

## Install

```
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install time-machine@my-claude-code-mods
```

Requires Claude Code 2.1.287 or later (mods enabled by default) and `git`.

## Commands

Everything goes through a single `/tm <subcommand>`.

| Command | What it does |
|---|---|
| `/tm` or `/tm timeline [--all] [--branch b]` | Timeline tree (last 30 steps; `--all` for everything). Each step shows its number, tool, target and markers (test result, denied, error, snapshot) |
| `/tm show <n>` | Step details: input (truncated display), result head, changed files, test result, snapshot commit and time |
| `/tm diff <a> [b]` | `diff --stat` and patch between the snapshots of steps a and b (default: current); at most 400 lines, nothing past that is read |
| `/tm why [n]` | Suspects and fixed-by for test run n (default: the last failure). A passing run has no suspects |
| `/tm restore <n> [--yes]` | Restores the file state of step n. Dry run without `--yes` |
| `/tm branch <n> [name] [--yes]` | Like restore, but records the following steps on a new branch |
| `/tm compare <a> <b>` | Compares two paths (a branch or `session:<id>[/<branch>]`): fork point, each side's steps, file diff stats, last test result |
| `/tm rerun <n> [--write] [--isolated [--yes]]` | Runs the tool again with step n's input and compares the results |
| `/tm sessions` | Recorded sessions for this project (session id, "(this session)" marker, start time) |
| `/tm-pane` | Live timeline pane |

Status line: `tm ⑫ · 5 snaps · 41ms` (last step number, snapshot count, average snapshot time). When snapshots are off, the status line only shows `tm ⑫ · snapshots off`; the reason appears at the head of the `/tm` timeline (`snapshots off: …`) and in the messages of other subcommands.

## How it records

- **Shadow git**: snapshots are committed to `<storeDir>/<projectKey>/shadow.git` (a bare repository). `projectKey` is the project root's name plus the first 8 characters of its path hash. Each session uses its own index (`index/<sessionId>`), and refs are `refs/tm/<sessionId>/<branch>`.
  The shadow repository's git environment (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` and so on) is pinned and any inherited `GIT_CONFIG_PARAMETERS` is cleared, so nothing is written to your `.git`. Current `.gitignore` rules are respected even for files an earlier shadow snapshot tracked: those files are removed from the shadow index before staging, without deleting working files or past snapshots. Your `.git/info/exclude` is copied into the shadow repository the first time the session uses git (the first mutating tool, or the first `/tm` command that uses git) and is not updated afterwards (except for linked worktrees, where `.git` is a file).
- **When snapshots are taken**: after mutating tools (Edit, MultiEdit, Write, NotebookEdit, Bash, unknown tools and MCP tools). Every Bash call is snapshotted by default, because redirections like `cat > f <<EOF` also write files. Nothing is committed when nothing changed. With the `skipSearchBash` setting on, Bash calls classified as search (rg, grep, ls, cat …) are skipped. Read-only tools are never snapshotted.
- **External-change steps**: if, *before* a mutating tool, the current tree differs from the previous snapshot (say, a human edited it in the IDE), the difference is recorded as an `external` step so it is not blamed on the agent.
- **Baseline**: taken right before the first mutating tool (or the first `/tm` command that uses git), so session start is not slowed down.
- **Concurrent tool calls**: a snapshot taken while another mutating tool is in flight is marked `concurrent`. The external-change check is skipped while another mutating tool is in flight (so that tool's writes are not counted as external changes).
- **Retention and cleanup**: old sessions are pruned once a day in a process detached after startup, using `git gc --auto`. The index files of deleted sessions, and temp folders older than a day left behind by interrupted `--isolated` reruns, are removed too.
- **Stored targets**: target strings such as Bash commands, patterns, URLs and agent descriptions have secrets masked and are cut at 120 characters.

## Observability grades

| Grade | Examples |
|---|---|
| exact | Tracked file contents at snapshot time (shadow git commits), tool inputs, tool result text (head) and its hash, exit status of test commands |
| parsed | Pass/fail counts, failing test names and failure locations file:line read from test output (only formats the parser knows: pytest, jest/vitest, go, cargo, node:test) |
| inferred | Causal suspect ranking, "fixed by", fork point of a path comparison |
| not reproduced | Model responses, external services, time, randomness |

## Causality (`/tm why`)

- **Reference point**: the last *passing* test run before the failing run F on the same branch with the same framework, normalized full command (including suite/options), invocation cwd and agent (or the baseline if there is none). Every file changed between the reference snapshot and F's snapshot gets a score.
- **Scoring**: +100 if the failure output mentions the path, +60 if it mentions only the file name (basename), +50 if a failure location (file:line) points at it, 0–20 for recency (closer to F scores higher), and ×2 per step that changed the file, up to 10. The top 5 are shown with their evidence and the step numbers that changed them.
- **fixed by**: if there is a first passing run P after F, the files and steps changed between F and P are shown. When the failure count drops (e.g. 3 failed → 1 failed) it is marked "improved".
- This is **inference, not proof.** The ranking is only a clue.

## Restore and branch

- `/tm restore <n>` and `/tm branch <n> [name]` are dry runs without `--yes`: they only show the files that would change (`A/M/D`) and their count.
- With `--yes`, the current state is first saved as a pre-restore snapshot, then the work tree is set to the target step's state. Tracked files absent from the target are deleted; ignored files are left alone.
- If the target step contains a path that is now ignored (e.g. a `.env` that used to be tracked is now in `.gitignore`, or a file `out` is now the ignored directory `out/`), the restore refuses and touches nothing: ignored files are in no snapshot, so overwriting them could not be undone. Move the paths named in the message aside and run it again. A directory holding only ignored files (e.g. restoring `pkg/a.py` when only `__pycache__/` is left in `pkg/`) is judged by the files inside it, so the restore goes ahead if no file actually collides.
- Restores and branches are recorded as a **new commit** holding the target's tree (parents = the pre-restore state and the target), so every snapshot stays reachable and the restore itself can be undone. If files change between the safety snapshot and the restore, the restore refuses ("the work tree changed since the last snapshot; run the restore again") — just run it again.
- A branch-restore step adds no files to the change list of `/tm why`: its tree equals step n's, so files changed only on the branch you left do not show up as failure suspects on the new branch. How the work tree changed is shown in the timeline (`work tree: …`) and in `workTree` of `/tm show`.
- Branch names are checked for duplicates case-insensitively and validated as git ref names before anything is applied.
- A note for the model is added to the conversation ("the work tree was restored to step n; earlier tool results for these files are stale, re-read them before editing"). **The conversation itself is not rewound or forked** — only the file state and the timeline move.
- Restores and branches with `--yes`, and every rerun (except the `--isolated` dry run), run **only when the user typed them directly** (origin composer/bridge/sdk). Otherwise they refuse and name the origin. Dry runs and read-only subcommands work from anywhere. None of this is exposed as a tool the model can call.

## Rerun (`/tm rerun`)

- Default: calls the tool again with the same input (going through the permission check). Only read-only tools are allowed; mutating tools and tools that do work when run again (`Agent`/`Task`, `Skill`, `SendMessage`, `KillShell`) need `--write` (mutating tools are snapshotted afterwards; for subagents and the like, the calls inside are recorded as their own steps). Either way it runs only when the user typed it directly. If the results hash the same it reports "identical"; otherwise a line diff summary, and for tests the pass/fail change.
- `--isolated` (Bash only; **snapshot copy, not a sandbox**): extracts the snapshot right before that step into a temp directory (`<storeDir>/<projectKey>/tmp/…`) and runs there. It is best effort, since ignored files (dependencies and so on) are missing, and it **does not go through the permission dialog.** So without `--yes` it is a dry run: it only shows the command to run (`$ …`), the snapshot it would use and caveats, and runs nothing. `/tm rerun <n> --isolated --yes` also runs only when the user typed it directly, and refuses commands that contain an absolute path into the project, as a guard against obvious writes to the original tree. Environment variables, home configuration and external services remain accessible. External changes are checked before and after the run, and if the project changes anyway it is recorded as an `external` step.
- Steps whose stored input was truncated or masked can be rerun only while the original input recorded in this load is still in memory (the last 500 steps, 32 MiB total). They cannot be rerun from another load (reload, resume).
- Model responses are not rerun.

## Restoring files ≠ deterministic replay

v1 only restores files and runs tools again; it does not replay model responses, external services (WebFetch, MCP), time or randomness. Model turns are recorded only as summaries and hashes.

v2 design sketch (not implemented): (1) a model-response cassette where a `turn.step` hook emits recorded chunks, keyed by request message hash + model + index. (2) A tool-result cassette where a `tool.call` hook answers with the result without calling `next`, keyed by (tool, input hash, previous snapshot commit). (3) WebFetch/WebSearch/MCP covered by the tool-result cassette; Bash that uses the network marked as not reproducible. (4) Time and randomness dependencies only warned about. (5) Replay run = new session + baseline restore + cassette mode; a cassette miss marks a "nondeterministic fork point".

## Settings

| Key | Default | Meaning |
|---|---|---|
| `storeDir` | `""` (`~/.claude/time-machine`) | Where snapshots and timelines live, one folder per project. Must be absolute (or `~/…`) and outside the project (otherwise snapshots are turned off) |
| `retentionDays` | `14` | Deletes session records older than this (once a day, detached after startup). `0` keeps everything |
| `recordModelOutput` | `false` | Stores model response bodies and the first 200 characters of prompts. When off, only lengths and hashes |
| `skipSearchBash` | `false` | Skips the snapshot after Bash classified as search |

## Storage layout

```
<storeDir>/<projectKey>/
  shadow.git/                       # shadow repository
  index/<sessionId>                 # per-session git index
  tmp/                              # temp work directories for --isolated reruns
  sessions/<sessionId>/meta.json    # { sessionId, root, startedAt }
  sessions/<sessionId>/<load>-<n>.jsonl
```

JSONL record kinds: `session`, `turn`, `step`, `model`, `branch`. A chunk rolls over to the next number past 256 KiB. A step's tool input is cut at 4 KiB per string field and the result head at 2 KiB (hash and length are kept), with secrets masked. Parsed failure names are also masked before being stored; test counts and invocation hashes are unchanged. The full `content` of Write and `old/new_string` of Edit are in the snapshot.

## Environments

| Environment | Behavior |
|---|---|
| Terminal | All commands, pane, status line |
| VS Code chat panel | Hooks and command text only (pane and status line are not shown) |
| `claude -p` | Recording and snapshots work. Commands run in the same process via stream-json input |

## Limitations

- Snapshots are turned off when git is missing, the root is HOME or `/`, `storeDir` is relative or inside the project, or the baseline snapshot takes more than 5 seconds (the timeline keeps recording). After that, a single failed snapshot (timeout, contention with another process) leaves only that step without a snapshot; snapshots are turned off only after 3 or more consecutive failures spanning more than 3 minutes. Lock files left behind by a dead git are removed after 2 minutes and the snapshot is retried. The reason appears at the head of the `/tm` timeline and in other subcommands' messages (the status line only shows `snapshots off`).
- If a nested git repository has no commits, `git add -A` fails, snapshots keep failing and are eventually turned off. Nested repositories' contents are not snapshotted (they are kept only as gitlinks).
- In large repositories every mutating tool pays the snapshot time (the average is on the status line).
- A log file inside the project that keeps changing produces an `external change` step before every mutating tool.
- Files changed later by a background Bash are attached to the next snapshot. Snapshot attribution for concurrent tool calls is approximate.
- `--isolated` only changes the working directory; it does not isolate the environment, home directory, network or external services. Commands can still touch the real tree indirectly.
- Test output in formats the parser does not know uses only the exit status. Locations in the middle of very long test output (outside the first/last 128 KiB) are not used for causality.
- Ignored files (build outputs, `node_modules`, `.env`) are not snapshotted or restored.
- It does not replace Claude Code's built-in `/rewind`. Time Machine also catches files changed by Bash and adds the timeline, causality and comparison.

Test run identity is a hash of the complete command (whitespace outside quotes is normalized for simple commands; commands with newlines or shell expansions are preserved) plus cwd. Earlier logs without an identity remain readable but are not linked as a baseline, fix or improvement. A same-command pass is still an inference, not proof of causation.

Storage state appears in the timeline, pane and status line: `recording`, `degraded` (some timeline data was saved but a write failed), or `not persisted` (no timeline write has succeeded in this load). Failed file bodies, including metadata and rolled-over chunks, stay in memory across clear/resume and retry on subsequent recording events and session end. A same-session resume reuses the in-memory recorder so unsaved steps keep their numbers. A continuing failure followed by process termination still loses unsaved memory. Secret keys such as `password`, `authorization`, `api_key` and `access_token` mask their entire values recursively; masked/truncated disk inputs are marked lossy. This supplements string masking and does not sanitize snapshot file contents.


Secret masking is best-effort and covers credential flags, sensitive headers, URL passwords, curl/mysql credentials and common credential fields in JSON strings. It does not sanitize snapshot file contents or retroactively rewrite saved files. Review files before sharing.


Reports and panels mask supported credential formats before truncation. Time Machine rerun previews mask displayed commands while replay uses the original in-memory input. Existing logs and snapshot file contents are not rewritten.

## Development

```bash
CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude
"$CLAUDE292" plugin test time-machine                 # from the repo root
npx -y -p typescript@5 tsc -p time-machine --noEmit   # after copying types into time-machine/.claude-plugin/types/ (do not commit)
"$CLAUDE292" plugin validate time-machine
```

Unit tests use a fake git runner to check command order, arguments, environment, output parsing and error paths. The test runner's `$` has no `process`, so real git is checked end to end (`-p` stream-json, one process).

## Data flow, commands and write scope

The `tool.call` hook observes tool inputs/results and snapshots local project files around mutating calls; it forwards the original call once. The `turn.step` hook observes model response text and usage while forwarding response chunks. Prompt/response character counts and hashes are recorded by default; enabling `recordModelOutput` also stores prompt heads (200 characters) and response bodies locally. Timeline metadata and masked input/result summaries stay in the local store; raw replay inputs may be retained in memory. Snapshot file contents are not secret-redacted. `$.fs.read` reads saved timeline/session JSONL and metadata; Git also reads project files and ignore rules for snapshots and comparisons. The only environment lookup is `$.env.get('HOME')`, used to expand the default/tilde store path and reject a home-directory snapshot root. `$.store.get/set` maintains the local prune schedule.

`runnerOf` in `hooks/register.tsx` forwards `argv` and options to `$.process.run(argv, opts)`, the host's local process bridge. The normal recording paths use the following programs and argument templates. Angle-bracket names below are runtime path/ref/hash values passed as individual argv entries, not shell substitutions. Let `B = <storeDir>/<projectKey>`, `G = B/shadow.git`, `W = <project root>`, `I = B/index/<sessionId>`, and `T = B/tmp/<load>-<step>-<time>`.

| Program and argv template | Reason and local read/write scope |
|---|---|
| `['mkdir', '-p', B + '/index']` | Creates the per-session index directory before Git initialization. |
| `['git', 'init', '--bare', '--quiet', G]` | Initializes the local shadow repository. |
| `['git', '--git-dir=' + G, '--work-tree=' + W, '-c', 'core.quotepath=off', ...args]` | Common Git prefix for every subcommand listed below; cwd is W. The pinned Git environment selects G and I. Export changes the work tree/cwd to T and index to `T + '.index'`. |
| `args = ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']`; `['update-index', '--force-remove', '--', ...paths]`; `['add', '-A']` | Reads project files/ignore rules, removes newly ignored paths from the shadow index in batches of 100, then stages nonignored project files into I/G. |
| `['rev-parse', '--verify', '-q', ref]`; `['rev-parse', commit + '^{tree}']`; `['write-tree']`; `['commit-tree', tree, ...parents, '-m', message]`; `['update-ref', ref, commit]` | Resolves snapshot state and writes shadow trees, commits and `refs/tm/<sessionId>/<branch>`. Parents are zero or more `['-p', commit]` pairs. |
| `['ls-tree', '-r', '--name-only', commit]`; `['diff', '--name-status', '-M', a, b]`; `['diff', '--stat', a, b]`; `['diff', a, b]` | Reads local snapshots to list baseline files, changed paths, diff stats and patch text. |
| `['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']`; `['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...dirs]`; `['ls-tree', '-r', '-z', '--name-only', target]` | Checks for ignored-file collisions before an explicit restore; the second form expands ignored directories when needed. |
| `['read-tree', '-u', '--reset', target]` | Explicit restore/branch writes/deletes project files to match the snapshot. Isolated export uses this same subcommand with T and its temporary index, writing the snapshot copy instead. |
| `['for-each-ref', '--format=%(refname)', prefix]`; `['update-ref', '-d', ref]`; `['gc', '--auto', '--quiet']` | Deletes expired sessions' shadow refs and performs local Git maintenance; never fetches or pushes. |
| `['find', lock, '-maxdepth', '0', '-type', 'f', '-mmin', '+2', '-delete', '-print']` | Deletes only a stale lock identified in a failed Git operation, after verifying it is this session's index lock or a path inside G. |
| `['sh', '-c', 'if [ -f "$1" ]; then mkdir -p "$(dirname "$2")" && cp "$1" "$2"; fi', 'tm-sync', W + '/.git/info/exclude', G + '/info/exclude']` | Fixed script uses local `mkdir`, `dirname` and `cp` to copy the project's exclude rules into G; it does not read credential files. |
| `['sh', '-c', <fixed bounded-diff script>, 'tm-diff', ...gitArgv]` | Runs the Git diff argv above through `"$@"`, piped to `head -n "$TM_LINES"` and `head -c "$TM_BYTES"`. The fixed script enables pipefail when supported and treats SIGPIPE exit 141 as success. Environment limits are 401 lines for `/tm diff` (400 displayed plus overflow detection) and 1 MiB. |
| `['rm', '-rf', sessionDir]`; `['rm', '-f', indexPath, indexLockPath]`; `['rm', '-f', orphanIndexPath]`; `['rm', '-rf', staleTmpPath]` | Retention removes expired session directories, their indexes/locks, orphan indexes and interrupted isolated-copy leftovers under B. Session identifiers and cleanup paths are checked before deletion. |
| `['mkdir', '-p', T]`; `['sh', '-lc', command]`; `['rm', '-rf', T, T + '.index']` | Only explicit `/tm rerun <n> --isolated --yes`: creates a snapshot copy, executes the original recorded Bash command with cwd T (10-minute timeout), then removes the copy/index. This shell command is user-selected replay input, not a fixed maintenance script. |

The exact fixed bounded-diff script in `ShadowGit.diffText` (`hooks/git.ts`) is:

```sh
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi; "$@" | head -n "$TM_LINES" | head -c "$TM_BYTES"; s=$?; [ "$s" -eq 141 ] && s=0; exit $s
```

It contains no downloaded or recorded instructions. File bodies flow to the local shadow repository and local diff output. The mod does not fetch command instructions from a server and has no direct HTTP endpoint, telemetry upload or configured network host. Its own Git snapshot operations do not fetch or push remotes. Classification patterns mentioning programs such as `npm`, `pytest` or `git` inspect recorded command strings; they do not execute those programs.

An explicit `/tm rerun` is different: it passes the selected recorded tool name and its input back to `$.tool.call` through normal host tool permissions. Bash reruns can execute the recorded command; network-capable tools or shell programs can contact the destinations specified in that original input and send whatever that tool/command specifies. These destinations are not a fixed mod host list. Mutating reruns require `--write`; isolated Bash reruns require `--isolated --yes` after preview. Merely observing a tool or viewing a timeline does not replay it. HTTP responses are not interpreted as new replay instructions.

`$.fs.write` saves generated timeline chunks and `meta.json` under `<storeDir>/<projectKey>/sessions/<sessionId>/`, with `storeDir` defaulting to `~/.claude/time-machine`. Shadow Git objects/refs, session indexes and isolated temporary work trees are also local beneath the configured project store. These paths are dynamic because projects, sessions and chunks differ. Restore/branch with `--yes` intentionally writes or deletes project files to match a selected snapshot: this can include build scripts, startup files, settings, and instruction files such as `CLAUDE.md` if they were snapshotted. Subsequent tools may run or obey restored files. Explicit mutating reruns can likewise edit the targets of the selected tool; timeline persistence itself writes only recording data.

For source review: `renderStep`'s `Object.keys(step.input)` loop uses `key` as an ordinary tool-input field name and formats the corresponding recorded value; it does not retrieve an API key, read credentials or open configuration files. Rendered values pass through secret masking. `isolationProblem`'s `/[.*+?^${}()|[\]\\]/g` is a regular-expression literal used to escape metacharacters in the project path before checking a replay command for an absolute-path reference; it is not a shell command. `RecordingStatus` is a static `import type` erased at runtime, with no dynamic module loading. `DurableWriter.status` and `Recorder.size` are pure in-memory getters (a computed status object and the recorded-step array length), with no I/O or replay side effects. These review clarifications preserve the recording, restore and explicit replay behavior.

Recording destinations are checked against the installed plugin directory after lexical normalization, including relative settings. If `storeDir` resolves inside this plugin, the mod performs no recording-file writes or Git snapshot/cleanup operations there; it reports `not persisted` and keeps the current timeline in memory only. Choose a directory outside the plugin and reload to restore persistence. Symlink targets and case aliases on case-insensitive filesystems are not canonicalized by this lexical check; configure a separate normal data directory, not a link or alternate spelling of installed code.

## Directory review: files, processes and observed tools

`fs.read` loads saved timeline chunks and comparison data from the configured local recording store. These values are parsed as timeline records and formatted into local reports; they are not sent as stdin or request bodies to a process/network service. The `process.run` bridge passes the argv and optional cwd/environment/timeout described in the program table above. Git reads project files itself for local shadow snapshots and comparisons, and extraction/copy/restore moves project bytes between the project and the configured local store/temp worktree. Those operations have no mod-controlled remote destination and do not run `git fetch` or `git push`.

The `tool.call` hook observes and records the original tool's summarized input, output and timing, then forwards that original call once. It does not convert returned URLs or response text into new commands. Its visibility includes network-capable tools; forwarding leaves their existing input, permissions and destination intact. Separately, explicit `/tm rerun` passes the selected recorded tool/input to the host, and `--isolated --yes` executes the selected Bash command in the extracted worktree. Such user-selected execution may read files or contact hosts/send data named by that command or tool, with its normal access; it is not restricted to a fixed host list. There is no server that feeds execution instructions into this mod. Viewing timelines and normal snapshot recording never initiate those replays. The mod's own network-host list is empty; replay destinations and effects are controlled by the selected recorded input.
