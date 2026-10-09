# Context Inspector — 컨텍스트 낭비 분석기

Claude Code 세션에서 컨텍스트 창을 무엇이 채우는지, 같은 정보가 왜 다시 들어오는지, 컴팩션이 무엇을 남기고 잃었는지 보여 주는 mod.
관찰만 한다: 행·도구 호출·컴팩션을 바꾸지 않는다.

## 설치

```
/plugin install context-inspector --marketplace YeonwooSung/my-claude-code-mods
```

Claude Code 2.1.287 이상(mods 기본 활성화). 그보다 오래된 빌드는 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## 명령

| 명령 | 내용 |
|---|---|
| `/context-inspect [overview\|occupants\|rereads\|similar\|compactions\|efficiency\|advice] [--agents]` | 텍스트 보고서. 기본은 main 컨텍스트의 overview, `--agents`는 서브에이전트 포함 |
| `/context-pane` | 실시간 패널(터미널, 데스크톱 앱) |
| `/context-export` | 원문 없이 메타데이터만 JSONL로 저장: `<outputDir>/<sessionId>/context-<load>-<n>.jsonl` |

상태줄: `ctx 62% · waste≈8.1k` (창 점유율은 측정값, 낭비는 추정).

## 무엇을 재는가 — 관찰 가능성 등급

| 등급 | 예 |
|---|---|
| measured | 요청마다 API가 보고한 입력 토큰(uncached + cache read + cache write), 컴팩션 전/후 토큰 |
| observed | 대화에 들어온 행의 문자 수·해시, 컴팩션 전/후 메시지 집합 |
| estimated (`≈`) | 항목별 토큰 = 문자 수/4(이미지 1,500) × 보정 계수 k (측정된 입력 증가량으로 0.5–2.0 사이에서 보정) |

모델 내부의 토큰별 주의(attention)나 정확한 점유율은 외부에서 보이지 않으므로 주장하지 않는다.

## 분석

- **점유**: 현재 창에 남은 항목을 범주(도구 이름, `attachment:<name>`, prompt/response)와 대상(파일, 명령)별로.
- **재읽기**: 같은 파일의 두 번째 이후 읽기를 분류한다 — `engine-deduped`(엔진이 "unchanged" 안내로 대신함), `restored`(컴팩션 후 엔진이 다시 붙임), `different-range`, `after-edit`, `after-compaction`, `changed-externally`, `unchanged-live`(이전 사본이 아직 창에 있음 = 순수 낭비).
- **유사 출력**: 같은 해시(정확) 또는 64비트 SimHash 해밍 거리 ≤ 3(근사). 단어 3-shingle 기반 **어휘** 유사도이며 의미(임베딩) 유사도가 아니다. 숫자는 `#`로 접어 실행 시간만 다른 테스트 출력도 묶인다.
- **컴팩션**: 컴팩션 전 대화에서 편집 파일·읽은 파일·오류·사용자 식별자를 뽑아, 요약과 유지된 메시지에 남았는지 본다. 잃은 편집 파일과, 컴팩션 때문에 다시 읽은 양(reflow)을 보고한다.
- **효율**: 메인 턴별 측정 입력 증가량 대비 변경 라인 수(Edit/MultiEdit/Write/NotebookEdit). 편집 없이 커진 턴은 "탐색 턴"으로 표시만 한다(탐색은 결함이 아니다).
- **추천**: 무변경 재읽기, 큰 파일 통째 읽기, 긴 명령 출력, 반복 출력, 컴팩션이 잃은 편집 파일, 컴팩션 후 재유입, 긴 서브에이전트 결과, 호출되지 않은 MCP 서버, 큰 메모리 파일. 각 추천에 근거와 ≈절감량이 붙는다.

## 설정 (userConfig)

| 키 | 기본 | 뜻 |
|---|---|---|
| `outputDir` | `~/.claude/context-inspector` | `/context-export` 위치 |
| `toastAdvice` | `true` | high 추천이 처음 생길 때 세션당 한 번 토스트 |

## 내보내기 형식

한 줄에 JSON 하나: `meta`, `item`(seq, ctx, turn, door, category, target, chars, est, hash, simhash, born, epoch, live …), `edit`, `sample`, `compaction`, `summary`.
원문은 없다. 명령·패턴·URL 대상은 비밀값 마스킹 후 200자로 자른다. 컴팩션 엔티티 중 오류와 사용자 식별자는 해시만 남는다.

## 실행 환경

| 환경 | 동작 |
|---|---|
| 터미널 | 상태줄, 패널, 토스트, 명령 모두 |
| VS Code 채팅 패널 | 훅과 명령 텍스트만(mod의 그림은 표시되지 않음) — `/context-inspect`가 기본 출력 |
| `claude -p` | 기록만; 명령은 `-p "/context-inspect"`로 실행 가능 |

## 한계

- 리로드·재개 시 `$.session.messages()`로 메인 대화만 복구한다(attachment, 서브에이전트, 시간 정보 없음).
- 복구는 세션 시작 후 한 번, 지연 실행되며 아직 아무것도 기록되지 않았을 때만 돈다. 그 전에 기록된 행이 있으면 리로드 이전 이력은 읽어 오지 않는다.
- 복구된 prompt/response 항목에는 엔진 핸들이 없다(`$.session.messages()`가 주지 않는다). 그래서 리로드 후 첫 컴팩션은 이들을 전부 "버려진 것"으로 센다. 도구 결과는 tool_use_id로 계속 대응된다.
- 원장 상한 20,000 항목(넘치면 창 밖 항목부터 버림).
- 컴팩션 보존 판정은 문자열 포함 여부다(파일은 basename도 인정) — 요약이 다른 말로 바꿔 쓴 것은 잃은 것으로 센다.
- 유사도 버킷은 밴드 값마다 서로 다른 대표를 최대 256개까지만 보관·비교한다(수천 개의 거의 같은 출력도 대표끼리는 묶인다).
- 내보내기 파일 이름은 항상 `-<n>`으로 끝난다(파일 하나면 `context-<load>-1.jsonl`). 같은 로드 안에서 `/context-export`를 다시 실행하면 그 로드의 파일을 전체 새 스냅샷으로 덮어쓴다.
- large-read·large-bash·agent-verbose 같은 추천은 세션에서 일어난 모든 일을 대상으로 하며, 이후 컴팩션이 지운 출력도 포함한다.

## 개발

```bash
CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude
"$CLAUDE292" plugin test context-inspector
cp -R agent-profiler/.claude-plugin/types context-inspector/.claude-plugin/types   # once, for tsc
npx -y -p typescript@5 tsc -p context-inspector --noEmit
"$CLAUDE292" plugin validate context-inspector
```
