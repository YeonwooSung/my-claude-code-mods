# Time Machine — 에이전트 타임머신

에이전트가 여러 파일을 바꾸다 엉뚱한 결과를 냈을 때, Git diff는 "무엇이 바뀌었나"만 알려 준다.
Time Machine은 **어떤 순서로, 어떤 도구 호출이, 어떤 파일 상태에서, 어떤 결과를 냈는지**를 기록하고, 임의의 step으로 돌아가 그 당시 파일과 도구 호출 내역을 볼 수 있게 한다.
파일 수정과 테스트 실패의 인과 추적, 시점 복구, 분기, 두 실행 경로 비교, 같은 입력 재실행도 지원한다.

```
Session #184
├── ① Read auth.py
├── ② Grep JWT
├── ③ Edit auth.py            └── snapshot A
├── ④ Bash pytest             └── 3 failed
├── ⑤ Edit middleware.py      └── snapshot B
└── ⑥ Bash pytest             └── 12 passed   (fixed by ⑤)
```

## 설치

```
/plugin install time-machine --marketplace YeonwooSung/my-claude-code-mods
```

Claude Code 2.1.287 이상(mods 기본 활성화)과 `git`이 필요하다.

## 명령

모두 `/tm <하위 명령>` 하나로 쓴다.

| 명령 | 내용 |
|---|---|
| `/tm` 또는 `/tm timeline [--all] [--branch b]` | 타임라인 트리(최근 30 step, `--all`은 전체). step마다 번호·도구·대상과 표식(테스트 결과, 거부, 오류, 스냅샷) |
| `/tm show <n>` | step 상세: 입력(잘린 표시), 결과 head, 바뀐 파일, 테스트 결과, 스냅샷 커밋·시간 |
| `/tm diff <a> [b]` | step a와 b(기본: 현재) 스냅샷 사이 `diff --stat`과 패치(최대 400줄) |
| `/tm why [n]` | 테스트 실행 n(기본: 마지막 실패)의 용의자와 fixed-by. 통과한 실행은 용의자가 없다 |
| `/tm restore <n> [--yes]` | step n의 파일 상태로 되돌린다. `--yes` 없이는 dry run |
| `/tm branch <n> [name] [--yes]` | restore와 같되 이후 step을 새 branch에 기록 |
| `/tm compare <a> <b>` | 두 경로(branch 또는 `session:<id>[/<branch>]`) 비교: 분기점, 각자의 step, 파일 diff 통계, 마지막 테스트 결과 |
| `/tm rerun <n> [--write] [--isolated [--yes]]` | step n의 입력으로 도구를 다시 실행하고 결과를 비교 |
| `/tm sessions` | 이 프로젝트의 기록된 세션 목록(세션 id, "(this session)" 표시, 시작 시각) |
| `/tm-pane` | 실시간 타임라인 패널 |

상태줄: `tm ⑫ · 5 snaps · 41ms` (마지막 step 번호, 스냅샷 수, 평균 스냅샷 시간). 스냅샷이 꺼지면 상태줄에는 `tm ⑫ · snapshots off`만 보이고, 이유는 `/tm` 타임라인 머리(`snapshots off: …`)와 다른 하위 명령의 메시지에 나온다.

## 어떻게 기록하나

- **섀도 git**: `<storeDir>/<projectKey>/shadow.git`(bare 저장소)에 스냅샷을 커밋한다. `projectKey`는 프로젝트 루트의 이름과 경로 해시 앞 8자. 세션마다 인덱스(`index/<sessionId>`)를 따로 쓰고, ref는 `refs/tm/<sessionId>/<branch>`.
  섀도 저장소의 git 환경(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY` 등)은 고정되어 있어 사용자의 `.git`에는 아무것도 쓰지 않는다. `.gitignore`를 따른다. 사용자의 `.git/info/exclude`는 세션에서 git을 처음 쓸 때(첫 변경성 도구 또는 git을 쓰는 첫 `/tm` 명령) 섀도 저장소로 복사되며 이후 갱신되지 않는다(`.git`이 파일인 linked worktree는 제외).
- **스냅샷 시점**: 변경성 도구(Edit, MultiEdit, Write, NotebookEdit, Bash, 알 수 없는 도구·MCP 도구) 뒤에 찍는다. Bash는 기본으로 모두 찍는다 — `cat > f <<EOF` 같은 리디렉션도 파일을 쓰기 때문이다. 변경이 없으면 커밋하지 않는다. 설정 `skipSearchBash`를 켜면 검색으로 분류된 Bash(rg, grep, ls, cat …)는 건너뛴다. 읽기 전용 도구는 찍지 않는다.
- **외부 변경 step**: 변경성 도구 *전*에 현재 트리가 직전 스냅샷과 다르면(사람이 IDE에서 고친 것 등) 그 차이를 `external` step으로 기록해 에이전트 탓으로 돌리지 않는다.
- **베이스라인**: 첫 변경성 도구 직전(또는 git을 쓰는 첫 `/tm` 명령)에 찍는다. 세션 시작을 늦추지 않기 위해서다.
- **동시 도구 호출**: 다른 변경성 도구가 진행 중일 때 찍은 스냅샷은 `concurrent`로 표시한다.
- **보존·정리**: 오래된 세션 정리는 시작 후 분리되어(detached) 하루 한 번 돌고, `git gc --auto`를 쓴다.
- **저장되는 대상**: Bash 명령, 패턴, URL, 에이전트 설명 같은 대상 문자열은 비밀값을 마스킹하고 120자에서 자른다.

## 관찰 가능성 등급

| 등급 | 예 |
|---|---|
| exact | 스냅샷 시점의 추적 파일 내용(섀도 git 커밋), 도구 입력, 도구 결과 텍스트(앞부분)와 해시, 테스트 명령의 종료 상태 |
| parsed | 테스트 출력에서 읽은 통과/실패 수, 실패 테스트 이름, 실패 위치 file:line (파서가 아는 형식만: pytest, jest/vitest, go, cargo, node:test) |
| inferred | 인과 용의자 순위, "fixed by", 경로 비교의 분기점 |
| not reproduced | 모델 응답, 외부 서비스, 시간, 난수 |

## 인과 (`/tm why`)

- **기준**: 같은 branch에서 실패한 실행 F 이전의 마지막 *통과* 테스트 실행(없으면 베이스라인). 기준 스냅샷부터 F 스냅샷 사이에 바뀐 파일마다 점수를 매긴다.
- **점수 규칙**: 실패 출력에 경로가 언급되면 +100, 파일명(basename)만 언급되면 +60, 실패 위치(file:line)가 가리키면 +50, 최근성(F에 가까울수록) 0–20, 그 파일을 바꾼 step 수 ×2, 최대 10. 상위 5개를 근거와 바꾼 step 번호와 함께 보인다.
- **fixed by**: F 다음 첫 통과 실행 P가 있으면, F와 P 사이에 바뀐 파일과 step을 보인다. 실패 수가 줄면(예: 3 failed → 1 failed) "improved"로 표시한다.
- 이것은 **추론이지 증명이 아니다.** 순위는 단서일 뿐이다.

## 복구와 분기

- `/tm restore <n>`과 `/tm branch <n> [name]`은 `--yes` 없이 dry run이다: 바뀔 파일(`A/M/D`)과 개수만 보이고 끝난다.
- `--yes`를 주면 먼저 현재 상태를 복구 전 스냅샷으로 남긴 뒤, 작업 트리를 대상 step의 상태로 맞춘다. 대상에 없는 추적 파일은 지워지고, 무시된 파일은 그대로 둔다.
- 대상 step이 지금은 무시되는 경로를 담고 있으면(예: 예전에 추적되던 `.env`가 지금은 `.gitignore`에 있음, 또는 파일 `out`이 지금은 무시되는 디렉터리 `out/`) 복구는 아무것도 건드리지 않고 거부한다: 무시 파일은 어느 스냅샷에도 없어 덮어쓰면 되돌릴 수 없기 때문이다. 메시지에 나온 경로를 옮겨 두고 다시 실행하면 된다.
- 복구와 분기는 대상의 트리를 가진 **새 커밋**(부모 = 복구 전 상태와 대상)으로 기록되므로 모든 스냅샷이 계속 도달 가능하고, 복구 자체도 되돌릴 수 있다. 안전 스냅샷과 복구 사이에 파일이 바뀌었으면 복구는 거부된다("the work tree changed since the last snapshot; run the restore again") — 다시 실행하면 된다.
- 분기 이름은 대소문자를 구분하지 않고 중복을 검사하고, git ref 이름으로 유효한지 적용 전에 확인한다.
- 대화에는 모델이 읽는 노트가 추가된다("작업 트리를 step n으로 되돌렸다; 이 파일들에 대한 이전 도구 결과는 오래됐으니 편집 전에 다시 읽어라"). **대화 자체는 되감거나 포크하지 않는다** — 파일 상태와 타임라인만 움직인다.
- `--yes`가 붙은 복구·분기는 **사용자가 직접 입력했을 때만** 실행된다(origin이 composer/bridge/sdk). 그 외에는 origin을 밝히며 거부한다. dry run과 읽기 전용 하위 명령은 어디서든 동작한다. 모델이 부르는 도구로는 노출되지 않는다.

## 재실행 (`/tm rerun`)

- 기본: 같은 입력으로 도구를 다시 부른다(권한 확인을 거친다). 읽기 전용 도구만 허용하며, 변경성 도구는 `--write`가 필요하다(실행 뒤 스냅샷). 결과가 해시로 같으면 "identical", 다르면 줄 diff 요약, 테스트면 통과/실패 변화를 보인다.
- `--isolated`(Bash만): 그 step 직전 스냅샷을 임시 디렉터리(`<storeDir>/<projectKey>/tmp/…`)에 풀어 거기서 실행한다. 무시 파일(의존성 등)이 없으므로 best effort이고, **권한 다이얼로그를 거치지 않는다.** 그래서 `--yes` 없이는 dry run이다: 실행할 명령(`$ …`), 쓸 스냅샷, 주의점만 보이고 아무것도 실행하지 않는다. `/tm rerun <n> --isolated --yes`는 사용자가 직접 입력했을 때만 실행되며(`rerun --write`도 마찬가지), 명령이 프로젝트의 절대 경로를 담으면 격리되지 않으므로 거부한다. 실행 전후로 외부 변경을 검사해, 그래도 프로젝트가 바뀌면 `external` step으로 남긴다.
- 저장된 입력이 잘렸거나 마스킹된 step은 이번 로드에서 기록한 원본 입력이 메모리에 있을 때만(최근 500 step) 재실행할 수 있다. 다른 로드(리로드·재개)에서는 재실행할 수 없다.
- 모델 응답은 재실행하지 않는다.

## 파일 복구 ≠ 결정적 재현

v1은 파일을 되돌리고 도구를 다시 실행할 뿐, 모델 응답·외부 서비스(WebFetch, MCP)·시간·난수는 재현하지 않는다. 모델 턴은 요약·해시만 기록한다.

v2 설계 요약(구현하지 않음): (1) `turn.step` 훅이 기록된 청크를 내보내는 모델 응답 카세트, 키 = 요청 메시지 해시 + 모델 + 인덱스. (2) `tool.call` 훅이 `next` 없이 결과를 답하는 도구 결과 카세트, 키 = (도구, 입력 해시, 직전 스냅샷 커밋). (3) WebFetch/WebSearch/MCP는 도구 결과 카세트로 덮고, 네트워크를 쓰는 Bash는 재현 불가로 표시. (4) 시간·난수 의존은 경고만. (5) 재현 실행 = 새 세션 + 베이스라인 복구 + 카세트 모드; 카세트 miss 지점이 "비결정적 분기점"이다.

## 설정

| 키 | 기본값 | 내용 |
|---|---|---|
| `storeDir` | `""` (`~/.claude/time-machine`) | 스냅샷과 타임라인을 두는 곳. 프로젝트별 폴더. 절대 경로(또는 `~/…`)여야 하고 프로젝트 밖이어야 한다(아니면 스냅샷이 꺼진다) |
| `retentionDays` | `14` | 이보다 오래된 세션 기록을 삭제(하루 한 번, 시작 후 분리 실행). `0`이면 모두 보존 |
| `recordModelOutput` | `false` | 모델 응답 본문과 프롬프트 앞 200자를 저장. 끄면 길이와 해시만 |
| `skipSearchBash` | `false` | 검색으로 분류된 Bash 뒤 스냅샷을 건너뜀 |

## 저장 형식

```
<storeDir>/<projectKey>/
  shadow.git/                       # 섀도 저장소
  index/<sessionId>                 # 세션별 git 인덱스
  tmp/                              # --isolated 재실행용 임시 작업 디렉터리
  sessions/<sessionId>/meta.json    # { sessionId, root, startedAt }
  sessions/<sessionId>/<load>-<n>.jsonl
```

JSONL 레코드 종류: `session`, `turn`, `step`, `model`, `branch`. 청크는 1 MiB를 넘으면 다음 번호로 넘어간다. step의 도구 입력은 문자열 필드마다 4 KiB, 결과 head는 2 KiB에서 자르며(해시와 길이는 남김) 비밀값은 마스킹한다. Write의 `content`, Edit의 `old/new_string` 전체는 스냅샷에 있다.

## 실행 환경

| 환경 | 동작 |
|---|---|
| 터미널 | 모든 명령, 패널, 상태줄 |
| VS Code 채팅 패널 | 훅과 명령 텍스트만(패널·상태줄은 표시되지 않음) |
| `claude -p` | 기록·스냅샷 동작. 명령은 stream-json 입력으로 같은 프로세스에서 |

## 한계

- git이 없거나, 루트가 HOME 또는 `/`이거나, `storeDir`이 상대 경로이거나 프로젝트 안이거나, 베이스라인 스냅샷이 5초를 넘으면 스냅샷이 꺼진다(타임라인은 계속 기록). 이유는 `/tm` 타임라인 머리와 다른 하위 명령의 메시지에 보인다(상태줄에는 `snapshots off`만).
- 중첩된 git 저장소에 커밋이 없으면 `git add -A`가 실패해 스냅샷이 꺼진다. 중첩 저장소의 내용은 스냅샷되지 않는다(gitlink로만 남는다).
- 큰 저장소에서는 변경성 도구마다 스냅샷 시간이 더해진다(상태줄에 평균).
- 프로젝트 안에서 계속 바뀌는 로그 파일이 있으면 변경성 도구마다 앞에 `external change` step이 생긴다.
- 백그라운드 Bash가 나중에 바꾼 파일은 다음 스냅샷에 붙는다. 동시 도구 호출의 스냅샷 귀속은 근사다.
- `--isolated`는 작업 디렉터리만 바꾼다. 절대 경로를 쓰는 명령은 여전히 실제 트리를 건드린다.
- 테스트 파서가 모르는 형식은 종료 상태만 쓴다. 매우 긴 테스트 출력의 중간(처음/마지막 128 KiB 밖)에 있는 위치는 인과에 쓰이지 않는다.
- 무시 파일(빌드 산출물, `node_modules`, `.env`)은 스냅샷·복구 대상이 아니다.
- Claude Code 내장 `/rewind`를 대체하지 않는다. Time Machine은 Bash가 바꾼 파일까지 잡고 타임라인·인과·비교를 더한다.

## 개발

```bash
CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude
"$CLAUDE292" plugin test time-machine                 # 저장소 루트에서
npx -y -p typescript@5 tsc -p time-machine --noEmit   # types를 time-machine/.claude-plugin/types/에 복사한 뒤 (커밋하지 않음)
"$CLAUDE292" plugin validate time-machine
```

단위 테스트는 가짜 git 러너로 명령 순서·인자·환경·출력 파싱·오류 경로를 검증한다. 테스트 러너의 `$`에는 `process`가 없어 진짜 git은 E2E(`-p` stream-json, 한 프로세스)로 확인한다.
