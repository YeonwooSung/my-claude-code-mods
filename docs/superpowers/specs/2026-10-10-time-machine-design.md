# Agent Time Machine — 설계 스펙

- 상태: 승인됨 (2026-10-10)
- 대상: Claude Code mods API (타입 선언 2.1.292, 기본 활성화 2.1.287+)
- 위치: `time-machine/` (이 저장소 = 마켓플레이스, agent-profiler·context-inspector와 나란히)

## 1. 목적

코딩 에이전트가 여러 파일을 바꾸다 엉뚱한 결과를 냈을 때, Git diff는 "무엇이 바뀌었나"만 말한다.
Time Machine은 "어떤 순서로, 어떤 도구 호출이, 어떤 파일 상태에서, 어떤 결과를 냈나"를 기록하고 되돌아가 보게 한다.

```
Session #184
├── ① Read auth.py
├── ② Grep JWT
├── ③ Edit auth.py            └── snapshot A
├── ④ Bash pytest             └── 3 failed
├── ⑤ Edit middleware.py      └── snapshot B
└── ⑥ Bash pytest             └── 12 passed   (fixed by ⑤)
```

핵심: 임의 시점(step)으로 이동했을 때 **그 당시 파일시스템 상태**와 **도구 호출 내역**을 볼 수 있다.
확장(v1 포함): 시점 복구, 분기 생성, 두 실행 경로 비교, 파일 수정 ↔ 테스트 실패 인과 추적, 동일 입력 재실행 비교.

### 비목표와 정직한 경계

- **파일 상태 복구 ≠ LLM 실행의 결정적 재현.** v1은 파일을 되돌리고 도구를 다시 실행할 뿐, 모델 응답·외부 서비스(WebFetch, MCP)·시간·난수는 재현하지 않는다.
  모델 턴은 기록(요약·해시)만 한다. 재현에 필요한 기록·모킹 계층은 §9에 설계만 남긴다.
- `.gitignore`된 파일(빌드 산출물, `node_modules`, `.env` 등)은 스냅샷·복구 대상이 아니다.
- 대화 자체를 포크하지 않는다(`/tm branch`는 파일 상태와 타임라인만 분기한다).
- Claude Code 내장 `/rewind`(Edit/Write 도구의 파일 체크포인트)를 대체하지 않는다. Time Machine은 Bash가 바꾼 파일까지 잡고, 타임라인·인과·비교를 더한다.

## 2. 관찰 가능성 등급

| 등급 | 예 |
|---|---|
| exact | 스냅샷 시점의 추적 파일 내용(섀도 git 커밋), 도구 입력, 도구 결과 텍스트(앞부분)와 해시, 테스트 명령의 종료 상태 |
| parsed | 테스트 출력에서 읽은 통과/실패 수, 실패 테스트 이름, 실패 위치 file:line (파서가 아는 형식만) |
| inferred | 인과 용의자 순위, "fixed by", 경로 비교의 분기점 |
| not reproduced | 모델 응답, 외부 서비스, 시간, 난수 |

## 3. 프로브로 확인한 사실 (2.1.292 바이너리, 2026-10-10)

- `$.process.run(['git', '--git-dir=<shadow>', '--work-tree=<cwd>', …])`가 mod에서 동작한다. `add -A` + `commit`이 작은 저장소에서 약 20 ms씩, 한 스냅샷 ≈ 40 ms.
- Bash가 지운 파일(삭제)과 새 파일이 다음 스냅샷에 잡힌다. `.gitignore`가 적용된다(`out.log` 제외). 사용자의 `.git`은 건드리지 않는다(git은 `.git` 항목을 추가하지 않는다).
- `$.fs`에는 read(≤ 4 MiB)/write/list/exists/stat만 있고 **삭제가 없다** → 복구와 정리는 git·`$.process.run`으로 한다.
- 테스트 러너의 `$`에는 `process`가 없다(`$.process` undefined).
- `$.process.run`의 `env`로 `GIT_INDEX_FILE`을 세션별로 줄 수 있다. git은 저장소 훅이 꺼진 채 실행된다.
- `$.tool.call`은 엔진과 같은 `tool.call` 이벤트(권한 확인·다이얼로그 포함)로 도구를 다시 부른다.
- `$.session.append({ message: { type: 'user', content: [text] } })`로 모델이 읽는 노트를 대화에 넣을 수 있다.

## 4. 아키텍처

순수 코어 + 얇은 어댑터 + git 래퍼.

```
time-machine/
  .claude-plugin/plugin.json   # userConfig: storeDir, retentionDays, recordModelOutput, skipSearchBash
  hooks/hooks.json
  hooks/register.tsx           # 어댑터: 이벤트 → Recorder, 명령, 패널, 노트
  hooks/core/
    types.ts                   # Step, Snapshot, TestRun, Branch, SessionMeta
    timeline.ts                # Recorder 상태 기계(steps, branches, turns), 직렬화/역직렬화
    tools.ts                   # 도구 분류(mutating/read-only), 입력 요약·대상 추출, 결과 요약
    classify.ts                # Bash 명령 분류 (agent-profiler에서 복사)
    testparse.ts               # 테스트 출력 파서: pytest, jest/vitest, go, cargo, node:test, generic
    causality.ts               # 실패 실행의 용의자, fixed-by
    compare.ts                 # 두 경로의 LCS 정렬, 분기점, 요약
    render.ts                  # 타임라인 트리, step 상세, why, compare, rerun 비교, 상태줄
    store.ts                   # JSONL 청크 경로·분할 규칙(순수)
    redact.ts                  # agent-profiler의 비밀값 마스킹 (복사)
  hooks/git.ts                 # 섀도 git 래퍼: init, snapshot, treeOf, diff, restore, checkoutTo, prune (직렬 큐)
  tests/*.test.ts
  README.md
```

### 4.1 저장소 배치

- 루트: userConfig `storeDir`(기본 `~/.claude/time-machine`)/`<projectKey>`/. `projectKey` = 세션 루트 절대 경로의 basename + `-` + fnv1a64(경로) 앞 8자.
- `shadow.git/`: bare 저장소. 세션별 인덱스 `index/<sessionId>`(`GIT_INDEX_FILE`), 세션별 ref `refs/tm/<sessionId>/<branch>`.
  커밋 작성자 `time-machine <tm@local>`, 메시지 = `step <n> <tool> <sessionId>`.
- `sessions/<sessionId>/meta.json`: `{ sessionId, root, startedAt, model?, branches }`.
- `sessions/<sessionId>/<loadId>-<chunk>.jsonl`: 타임라인 레코드(§4.3). 청크는 1 MiB를 넘으면 다음 번호로. 현재 청크는 레코드 추가 때마다 통째로 다시 쓴다(`$.fs.write`에 append가 없다).

### 4.2 스냅샷

- **베이스라인**: 세션 시작(또는 로드) 시 1회 `snapshot(label='baseline')`.
- **변경성 도구 후**: Edit, MultiEdit, Write, NotebookEdit, Bash, 그리고 알 수 없는 도구·MCP 도구(보수적으로) 뒤에 `snapshot`.
  읽기 전용 도구(Read, Grep, Glob, LS, WebFetch, WebSearch, TodoWrite, Task/Agent 자체 등)는 스냅샷 없음.
  userConfig `snapshotReadOnlyBash`(기본 false): false면 classify가 `search`인 Bash는 건너뛴다.
- **외부 변경 감지**: 변경성 도구 *전*에 `treeOf()`(add -A + write-tree)로 현재 트리를 구해 직전 스냅샷 트리와 다르면, 그 차이를 커밋하고 `external` step으로 기록한다(사람이 IDE에서 고친 것을 에이전트 탓으로 돌리지 않기 위해).
- `snapshot`: `add -A` → `write-tree` → 트리가 직전과 같으면 커밋하지 않고 직전 커밋을 그대로 가리킨다(`changed: false`). 다르면 `commit-tree -p <prev>` + ref 갱신.
  `diff --name-status <prev> <new>`로 바뀐 파일 목록(`A/M/D/R`)을 step에 붙인다(최대 200개, 넘치면 개수만).
- **직렬 큐**: 모든 git 호출은 한 Promise 큐로 직렬화(병렬 도구 호출·인덱스 잠금). 다른 변경성 도구가 진행 중일 때 찍힌 스냅샷은 `concurrent: true`.
- **시간 예산**: 각 git 호출 timeoutMs 30 s. 스냅샷 시간(ms)을 step에 기록하고 보고서에 평균·최대를 보인다.
- **git 없음/실패**: 첫 git 호출이 실패하면 세션 동안 `snapshots: off`로 전환, 타임라인만 기록하고 상태줄·보고서에 이유를 보인다.

### 4.3 타임라인 레코드 (JSONL)

```
{type:'session', sessionId, root, startedAt, loadId}
{type:'turn', n, at, prompt:{chars, hash, head?}}                              // head: 앞 200자, recordModelOutput일 때만
{type:'step', n, id, turn, agentId?, branch, parent, tool, kind:'tool'|'external'|'restore'|'baseline',
  input, target?, startedAt, endedAt, result:{isError, denied, chars, hash, head}, 
  snapshot?:{commit, changed, files:[{status,path}], ms, concurrent?}, test?:TestRun, rerunOf?}
{type:'model', turn, index, agentId?, model, stopReason, usage, text:{chars, hash, body?}, toolUses:[{id, tool}]}
{type:'branch', name, fromStep, at}
```

- `input`: 도구 입력. 문자열 필드는 4 KiB에서 자르고 `…(+N chars, hash)`; Write의 `content`, Edit의 `old/new_string`은 앞 4 KiB만(전체는 스냅샷에 있다).
  Bash `command`와 문자열 입력 전체에 redact를 적용한다.
- `result.head`: 결과 텍스트 앞 2 KiB(redact 적용). 전체는 저장하지 않는다(재실행 비교는 해시 + head).
- step 번호 `n`은 세션 안에서 1부터 단조 증가(분기와 무관). 표시는 ①②… (20 넘으면 숫자).
- `parent`: 같은 branch의 직전 step n(첫 step은 분기 지점 또는 0). `branch`: 기본 `main`.

### 4.4 테스트 실행과 인과

- Bash step의 `command`를 classify → `test`면 `testparse(output, exitCode?)`로 `TestRun { framework, passed?, failed?, errors?, skipped?, failures:[{name, file?, line?}], ok }`.
  - pytest: `=+ (\d+ failed)?, ?(\d+ passed)? … in` 요약줄, `FAILED path::name`, 트레이스백의 `path:line:`.
  - jest/vitest: `Tests: +(\d+) failed, (\d+) passed`, `● Suite › name`, `FAIL path`, `at … (path:line:col)`.
  - go: `--- FAIL: Name`, `FAIL\tpkg`, `ok\tpkg`, `file_test.go:line:`.
  - cargo: `test result: (ok|FAILED). (\d+) passed; (\d+) failed`, `---- name stdout ----`, `src/x.rs:line:col`.
  - node:test: `# pass N`, `# fail N`, `not ok N - name`.
  - generic: 결과가 오류(`isError`)면 실패, 아니면 통과로 보되 counts 없음(`framework:'unknown'`).
- **용의자(why)**: 실패한 테스트 실행 F에 대해, 기준 B = 같은 branch에서 F 이전의 마지막 *통과* 테스트 실행(없으면 베이스라인).
  B 스냅샷 → F 스냅샷 사이에 바뀐 파일 각각에 점수: 실패 출력에 그 경로(또는 basename)가 등장 +100, file:line이 등장 +50, 마지막으로 바뀐 step이 F에 가까울수록 +(0..20), 바뀐 줄 수 log2 +(0..10).
  상위 5개를 근거와 함께 보인다. 그 파일을 바꾼 step 번호도 함께.
- **fixed by**: F 다음의 첫 통과 실행 P가 있으면, F→P 사이 바뀐 파일과 그 step들을 "fixed by"로 보인다.
- 실패 수 증감(예: 3 failed → 1 failed)은 "improved"로 표시.

### 4.5 복구와 분기

- `/tm restore <n> [--yes]`: 대상 = step n의 스냅샷(스냅샷이 없는 step이면 그 이전 가장 가까운 스냅샷).
  1) `--yes` 없으면 dry run: 바뀔 파일 목록(`A/M/D`)과 개수만 보이고 끝.
  2) 있으면: 현재 상태를 `restore-from` 스냅샷으로 먼저 커밋(복구 자체를 되돌릴 수 있게) → `read-tree -u --reset <target>`(세션 인덱스로; 추적 파일을 대상에 맞추고 대상에 없는 추적 파일은 지운다, 무시 파일은 그대로) → `kind:'restore'` step 기록(스냅샷 = 대상 커밋) → 대화에 노트 append:
     `[time-machine] The user restored the working tree to step <n> (<tool> <target>). Files changed: …. Earlier tool results about these files are out of date; re-read before editing.`
  3) 턴이 진행 중이면 거부(`busy`)하고 이유를 보인다(명령은 턴 사이에 실행된다).
- `/tm branch <n> [name] [--yes]`: restore와 같되 이후 step들은 새 branch(`name`, 기본 `b<k>`)에 기록, `branch` 레코드 추가, ref `refs/tm/<sid>/<name>`.
  대화는 포크되지 않는다는 점을 출력과 노트에 적는다.
- 복구는 사용자 명령으로만 실행된다(모델이 부를 수 있는 도구로 노출하지 않는다).
- 무시 파일은 스냅샷되지 않으므로, 대상 트리가 무시되고 추적되지 않는 경로를 덮어쓰거나 지울 때(같은 경로, 또는 한쪽이 다른 쪽의 디렉터리 접두: `out/` ↔ `out`, `d` ↔ `d/f`) 복구는 아무것도 건드리지 않고 거부한다: `restore would overwrite ignored files that no snapshot holds: <최대 10개>; move them aside and run the restore again`. 강제로 add하지 않는다(무시된 비밀값이 섀도 저장소로 복사되므로). 검사는 `ls-files -z --others --ignored --exclude-standard --directory`와 `ls-tree -r -z --name-only <target>`로, 직렬 큐 안에서 commit-tree 전에 한다.

### 4.6 비교

- `/tm compare <a> <b>`: a, b는 branch 이름 또는 `session:<id>[/<branch>]`(같은 프로젝트의 다른 세션 기록).
- 각 경로 = 그 branch를 따라간 step 목록(분기 이전 공통 부분 포함). 키 = `tool + ' ' + 대상`(대상 없으면 tool).
- LCS로 정렬 → 첫 불일치 = 분기점. 출력: 공통 접두 길이, 분기점 이후 각자의 step(최대 20), 각 경로 마지막 스냅샷 간 파일 diff 통계, 각 경로 마지막 테스트 결과, 스냅샷 시간 합계.

### 4.7 재실행

- `/tm rerun <n> [--write] [--isolated]`:
  - 기본: `$.tool.call({ tool, ...input })`로 같은 입력 재호출(권한 확인 포함). 읽기 전용 도구만 허용; 변경성 도구는 `--write`가 있어야 하며 그 뒤 스냅샷.
    결과 비교: 해시 같음 → "identical"; 다르면 head 기준 줄 diff 요약(+/− 줄 수, 처음 다른 줄 3개). 테스트면 TestRun 비교(passed/failed 변화).
  - `--isolated`(Bash만): step n 직전 스냅샷을 임시 디렉터리(`<storeDir>/<projectKey>/tmp/<rand>`)에 `git archive | tar -x`(또는 `checkout-index --prefix`)로 풀고 `$.process.run(['sh','-lc',command], { cwd: tmp, timeoutMs })`로 실행 → 결과 비교 → 임시 디렉터리 삭제.
    무시 파일(의존성 등)이 없으므로 best effort이며, 출력 머리에 그 사실을 적는다. 이 경로는 권한 다이얼로그를 거치지 않으므로 사용자 명령으로만 실행되고, 실행할 명령을 출력에 먼저 보인다.
- 모델 응답은 재실행하지 않는다(§9).

### 4.8 UI와 명령

모두 `/tm <sub>` 하나로(등록 1개, `argumentHint`).

| 명령 | 내용 |
|---|---|
| `/tm` 또는 `/tm timeline [--all] [--branch b]` | 타임라인 트리(최근 30 step, `--all` 전체). step마다 번호·도구·대상·결과 한 줄·스냅샷 표식·테스트 요약 |
| `/tm show <n>` | step 상세: 입력(잘린 표시), 결과 head, 바뀐 파일, 테스트 결과, 스냅샷 커밋·시간 |
| `/tm diff <a> [b]` | step a와 b(기본: 현재) 스냅샷 사이 `diff --stat` + 패치(최대 400줄, 넘치면 잘림 표시) |
| `/tm why [n]` | 실패 테스트 실행 n(기본: 마지막 실패)의 용의자와 fixed-by |
| `/tm restore <n> [--yes]` | §4.5 |
| `/tm branch <n> [name] [--yes]` | §4.5 |
| `/tm compare <a> <b>` | §4.6 |
| `/tm rerun <n> [--write] [--isolated]` | §4.7 |
| `/tm sessions` | 이 프로젝트의 기록된 세션 목록(시작 시각, step 수, branch) |
| `/tm-pane` | 실시간 타임라인 패널 |

상태줄: `tm ⑫ · 5 snaps · 41ms` (마지막 step 번호, 스냅샷 수, 평균 스냅샷 시간). 스냅샷 꺼짐이면 `tm ⑫ · snapshots off`.

## 5. 이벤트

| 이벤트 | 용도 |
|---|---|
| `session.start` | 저장소 준비(init), 세션 메타, 이전 기록 로드(리로드면 같은 sessionId의 청크를 읽어 복원), 보존 기간 정리, 베이스라인, 명령 등록 |
| `session.end` (reason `clear`/`resume`) | 새 세션 id로 Recorder 전환(§4.1의 새 세션 폴더), 베이스라인 |
| `turn.start` | turn 레코드 |
| `tool.call` | 변경성이면 외부 변경 감지 → `next(e)` → step 기록 → (변경성) 스냅샷 → 테스트 파싱. 결과는 그대로 반환 |
| `turn.step` | stop 청크: model 레코드(usage, stopReason); 텍스트 청크 길이·해시(recordModelOutput면 본문) |
| `command.run` / `ui.render` | 명령·패널 |

## 6. 오류 처리 — 세션을 방해하지 않는다

- 모든 훅은 `next(e)`의 결과를 그대로 반환. 기록·git·파일 쓰기는 try/catch, 실패는 상태줄·보고서에 한 줄로.
- `tool.call`은 스냅샷을 기다린 뒤 반환한다(다음 도구가 파일을 바꾸기 전에 상태를 고정하기 위해). 이 대기는 git 시간만큼 도구 완료를 늦춘다 — 보고서에 측정값을 보인다.
- `.catch(($, e, next) => next(e))`를 tool.call, turn.step(생성기), session.end에.
- 복구/분기/재실행은 명시적 사용자 명령 + 복구·분기는 `--yes`. 복구 전 항상 현재 상태를 스냅샷.
- 사용자의 `.git`, 무시 파일은 절대 쓰지 않는다. 섀도 저장소는 `storeDir` 밖에 쓰지 않는다(임시 디렉터리도 그 안).

## 7. 보존

- `session.start`에서 `retentionDays`(기본 14)보다 오래된 세션 폴더 삭제(`$.process.run(['rm','-rf',dir])`, `storeDir/<projectKey>/sessions/` 아래인지 경로 검사 후), 해당 ref 삭제, `git gc --prune=now --quiet`를 하루 한 번(`$.store`에 마지막 실행 시각).

## 8. 테스트

- 코어 단위: Recorder(번호, branch/parent, 직렬화 왕복), tools(분류·입력 요약·자르기·redact), classify, testparse(형식별 샘플 출력), causality(용의자 점수, fixed-by, improved), compare(LCS, 분기점), render(트리·상세·why·compare), store(청크 분할).
- git 래퍼: 테스트 러너의 `$`에는 `process`가 없어(프로브 확인) 진짜 git을 단위 테스트에서 돌릴 수 없다. 그래서 `git.ts`는
  `Runner = (args: string[], opts: { env?, cwd?, timeoutMs? }) => Promise<{ exitCode, stdout, stderr }>`를 주입받고,
  단위 테스트는 가짜 Runner(호출을 기록하고 각본대로 답함)로 명령 순서·인자·환경(`GIT_INDEX_FILE`)·출력 파싱(name-status, write-tree 비교)·오류 경로(git 없음 → snapshots off)를 검증한다.
  실제 동작(변경/무변경/삭제/무시 파일, restore 삭제 포함, restore-from 커밋, branch ref)은 E2E로 검증한다.
- 어댑터: 명령 응답, tool.call 결과 무변형, dry run 출력.
- E2E(2.1.292 `-p` stream-json, 한 프로세스): 파일 Read → Edit → 실패 테스트(Bash) → Edit → 통과 테스트 → `/tm` → `/tm why` → `/tm restore 3 --yes` → 파일 내용 확인.

## 9. v2 설계 노트: 결정적 재현을 위한 기록·모킹 계층 (구현하지 않음)

mods API로 가능한 구조:
1. **모델 응답 카세트**: `turn.step` 훅이 `next` 없이 기록된 청크를 내보내면(제너레이터) 엔진은 그것을 모델 응답으로 쓴다. 키 = 요청 메시지들의 해시(`$.session.messages({as:'api'})`) + 모델 + 인덱스. v1의 `model` 레코드에 `recordModelOutput`로 본문·toolUses 입력을 남기면 이 카세트의 원료가 된다.
2. **도구 결과 카세트**: `tool.call` 훅이 `next` 없이 `{ result }`로 답한다. 키 = (tool, 입력 해시, 직전 스냅샷 커밋). 파일 상태는 섀도 git이 재구성.
3. **외부 서비스**: WebFetch/WebSearch/MCP는 도구 결과 카세트로 덮는다. 네트워크를 쓰는 Bash는 카세트 없이는 재현 불가로 표시.
4. **시간·난수**: 테스트가 의존하면 재현 불가. 기록 시 `date`, 시드 등을 감지해 경고만.
5. 재현 실행 = 새 세션 + 베이스라인 복구 + 카세트 모드. 카세트 miss 지점이 곧 "비결정적 분기점".

## 10. 실행 환경

| 환경 | 동작 |
|---|---|
| 터미널 | 모든 명령, 패널, 상태줄 |
| VS Code 채팅 패널 | 훅과 명령 텍스트만(패널·상태줄은 표시되지 않음) — `/tm` 텍스트가 기본 출력 |
| `claude -p` | 기록·스냅샷 동작; 명령은 stream-json 입력으로 같은 프로세스에서 |

## 11. 계획 단계에서 정한 보정 (2026-10-10)

1. **베이스라인은 git이 처음 필요할 때 찍는다**(첫 변경성 도구 직전, 또는 git을 쓰는 첫 `/tm` 명령). 훅의 `$`는 그 훅이 살아 있는 동안만 믿을 수 있고, 세션 시작을 git 시간만큼 늦추지 않기 위해서다. 베이스라인 = "기록된 첫 변경 직전의 상태". §4.2·§5의 "세션 시작 시 베이스라인"을 대체한다.
2. **Bash는 기본으로 모두 스냅샷**한다. classify가 `search`로 보는 명령도 리디렉션(`cat > f <<EOF`)으로 파일을 쓸 수 있기 때문이다. 변경이 없으면 커밋하지 않으므로 비용은 트리 해시 한 번. userConfig `skipSearchBash`(기본 false)를 켜면 `search` 명령은 건너뛴다. §4.2의 `snapshotReadOnlyBash`를 대체한다.
3. **스냅샷을 끄는 조건**: 세션 루트가 `/` 또는 HOME이면 꺼짐; 베이스라인 스냅샷이 5초를 넘으면 꺼짐(이후 모든 변경성 도구가 그만큼 느려지므로). 이유는 상태줄과 `/tm`에 보인다.
4. `turn.step`은 생성기 훅이라 `.catch`를 달지 않고, 기록은 모두 try 안에서 한다.
5. git 래퍼는 훅마다 그 훅의 `$`로 만든 Runner를 쓴다(`git.runner = runnerOf($)`).
6. 재실행 입력: 이번 로드에서 기록한 step은 메모리에 둔 원래 입력으로 재실행한다. 저장된 입력은 잘리거나 마스킹됐을 수 있어(`inputLossy`) 그런 step은 다른 로드에서 재실행하지 않는다.
