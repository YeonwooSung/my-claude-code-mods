# 모드 전체 비밀값 노출 경로 검토

이 문서는 수정 전 검토 기록이다. 순차 수정 결과는 [수정 기록](2026-10-17-privacy-fixes.md)을 참조한다. 동봉 재현 스크립트는 수정한 항목부터 비밀값이 없어야 하는 회귀 검사로 전환했다.

검토일: 2026-10-17 (Asia/Seoul). 기준 커밋: `07b7f04` (Context Inspector 0.1.1).

요청 범위는 이슈 #1과 비슷한 인증정보 노출이다. 7개 모드의 입력 수집, 표시, 파일 저장, 플러그인 저장소, 내보내기와 네트워크 전송 경로를 검토했다. 재현에는 가짜 값만 사용했으며 실제 사용자 세션, 인증정보 또는 외부 서버에는 접근하지 않았다. 이번 검토에서 제품 코드는 수정하지 않았다.

아래 P1은 우선 수정, P2는 후속 수정, P3는 표시 정책 보완을 권장하는 우선순위다. 실제 자격증명 유출 사고가 확인됐다는 뜻은 아니다. 로컬 저장과 외부 전송의 조건을 구분했다.

## 확인한 문제

### 1. [P1] Agent Profiler: 명령문 내보내기를 꺼도 검색 패턴의 비밀값은 OTLP에 남음

- 위치: `agent-profiler/hooks/core/otlp.ts:185`, `profiler.ts:40`, `hooks/register.tsx:133–184`.
- 재현: Grep 입력 `pattern: "API_KEY=FAKE_SEARCH_SECRET"`를 수집하고 기본 옵션으로 `toOtlp()`를 호출한다. 결과의 `agent_profiler.search.pattern`에 가짜 키가 원문으로 남는다.
- 원인: prompt/Bash만 `commandText`와 redactor를 통과하고 검색 패턴은 직접 attribute에 들어간다.
- 영향: 기본 설정에서도 자동 기록되는 OTLP 파일에 검색한 인증정보가 복제된다. 사용자가 `otlpEndpoint`를 설정했다면 같은 본문이 수집기로 전송된다. endpoint 기본값은 빈 문자열이므로 기본 설정에서 외부 전송이 일어나는 것은 아니다. 검색 패턴 자체의 내보내기는 문서에 설명돼 있지만 비밀값 필터는 없다.
- 대응: 검색 패턴도 기본적으로 제외하거나 별도 opt-in으로 만들고, 포함할 때 마스킹한다. 파일 경로 등 나머지 자유 문자열의 외부 전송 정책도 명시한다.

### 2. [P1] Time Machine: 나중에 무시한 파일에 추가한 비밀값도 새 스냅샷에 들어감

- 위치: `time-machine/hooks/git.ts:193–196`.
- 실제 Git 재현: `settings.txt`를 첫 스냅샷에 기록 → `.gitignore`에 `settings.txt` 추가 → 파일을 `FAKE_NEWLY_IGNORED_SECRET`으로 변경 → 다음 스냅샷 생성 → `git show <새 커밋>:settings.txt`에서 새 비밀값 확인.
- 원인: shadow index가 이미 추적하는 파일에 `git add -A`를 사용한다. `.gitignore`는 추적 중인 파일을 제외하지 않는다. 프로젝트 Git에서 파일을 추적하는지와도 별개다.
- 영향: 사용자가 무시 설정을 추가한 이후의 값도 로컬 shadow 저장소에 계속 복제된다. 처음부터 무시된 파일을 기록한다는 주장은 아니다. 과거 스냅샷을 보존하는 정상 동작과도 구분해야 한다.
- 대응: 현재 무시 정책에 해당하는 파일을 shadow index에서 제외하고, 제외된 파일에 대한 restore 충돌 처리도 함께 검증한다. 과거에 이미 저장한 비밀값의 정리 정책은 별도로 다룬다.

### 3. [P2] Time Machine: 실패 테스트 이름이 마스킹된 결과 요약을 우회해 JSONL에 저장됨

- 위치: `time-machine/hooks/core/testparse.ts:146–150`, `hooks/register.tsx:359–360`.
- 재현: `not ok 1 - API_KEY=FAKE_TEST_NAME\n# pass 0\n# fail 1`을 결과로 넣는다. `summarizeResult().head`에서는 키가 지워지지만 `parseTestOutput().failures[0].name`에는 남고, Recorder → ChunkWriter JSONL에도 그대로 기록된다.
- 원인: 전체 원문을 따로 파싱한 테스트 메타데이터가 마스킹 없이 `step.test`에 저장된다. 화면에서 실패 이름을 마스킹하는 것만으로 디스크 기록은 보호되지 않는다.
- 영향: 기본 기록 경로에서 테스트 이름에 포함된 인증정보가 로컬 로그에 남는다. 파라미터 기반 테스트가 입력값을 이름에 포함하면 발생할 수 있다.
- 대응: 비교·동일성 판정용 내부 데이터와 저장·표시용 데이터를 분리하고, 저장 직전에 실패 이름 등 자유 문자열을 마스킹한다.

### 4. [P2] Agent Profiler / Time Machine / Loop Detective: 마스킹 규칙의 불일치

- 위치: `agent-profiler/hooks/core/redact.ts:3–9`, `time-machine/hooks/core/redact.ts:3–9`, `loop-detective/hooks/core/fingerprint.ts:20–30`.
- Agent Profiler: `exportCommandText=true`일 때 `gh api --token FAKE_COMMAND_SECRET /user`가 OTLP에 남는다. 기본값 false에서는 이 Bash 명령 자체가 제외되는 대조 검사도 통과했다.
- Time Machine: 동일 형식의 토큰이 기본 JSONL input에 남고 `inputLossy`도 설정되지 않는다. URL userinfo 비밀번호와 JSON 문자열 내부 `{"token":"FAKE_JSON_TOKEN"}`도 저장된다. `.gitignore`는 Write/Edit 입력 로그에 적용되지 않으므로, 스냅샷에서 제외할 파일 내용도 input 요약으로 복제될 수 있다.
- Loop Detective: `curl -u alice:FAKE_CURL_PASSWORD`, URL userinfo, `mysql -pFAKE_MYSQL_PASSWORD`, `--secret FAKE_FLAG_SECRET`이 반복 실패 케이스 보고서에 남는다. `--token "FAKE_PREFIX\"FAKE_ESCAPED_TAIL"`은 뒤쪽 비밀값이 남는다. 이 모드는 자체 파일/네트워크 내보내기가 없으며 영향은 메모리와 보고서·패널 표시다.
- 대조: Time Machine의 실제 중첩 객체 `{ token: "..." }`는 마스킹된다. 같은 내용이 `content` 같은 필드의 JSON 문자열이면 객체 순회를 받지 않는다.
- 대응: 같은 가짜 입력 corpus를 모든 모드의 redactor에 적용한다. 독립 플러그인 배포 구조 때문에 다른 모드 디렉터리를 직접 import하는 단순 공용화는 피하고, 배포 시 각 플러그인이 자체적으로 완결되는 방식을 사용한다.

### 5. [P2] Agent Profiler / Time Machine: 자르기를 먼저 수행해 정상 마스킹되는 값이 새어 나옴

- 위치: `agent-profiler/hooks/core/profiler.ts:17,27,96`, `time-machine/hooks/core/tools.ts:128`, `time-machine/hooks/core/compare.ts:86`.
- 재현: `--password "FAKE_CUT_RESULT` 뒤에 충분히 긴 문자열과 닫는 따옴표를 붙인다. 전체 문자열을 redactor에 전달하면 지워지지만, Time Machine은 2,048자에서 먼저 자르므로 닫는 따옴표가 사라지고 비밀번호 앞부분이 JSONL result head와 rerun 비교에 남는다.
- Agent Profiler도 prompt 120자/Bash 512자에서 수집 시 잘린 후 opt-in OTLP export에서 마스킹되어 같은 문제가 발생한다.
- 영향: 이미 지원한다고 여기는 `--password` 형식에서도 긴 값이 부분 노출된다. Time Machine의 결과 요약은 기본 기록 대상이며 Agent Profiler 명령·prompt 본문은 opt-in이다.
- 대응: 마스킹을 먼저 수행한 뒤 표시·저장 길이를 제한한다. 실행 분류나 replay에 원문이 필요하면 용도별 데이터를 분리하고, 긴 입력의 처리 비용도 제한한다.

### 6. [P2] Context Inspector 0.1.1: escaped quote가 있는 헤더는 부분 마스킹, JSON 본문은 미마스킹

- 위치: `context-inspector/hooks/core/redact.ts:9` 및 문자열 규칙 전체.
- 재현: `curl -H "x-api-key: FAKE_PREFIX\"FAKE_HEADER_TAIL" https://example.com`의 헤더 값에서 `FAKE_HEADER_TAIL`이 남는다. 헤더 규칙이 escaped quote를 값의 끝으로 취급한다.
- 추가 범위 공백: `curl -d '{"token":"FAKE_CONTEXT_JSON"}' https://example.com`은 원문으로 남는다. 앞선 수정은 CLI 옵션·헤더·URL·curl 인증정보를 추가한 것으로, 문자열 내부 JSON 자격증명까지 처리하지는 않는다.
- 영향: 두 값 모두 `redactSecrets()` 출력에 남으므로 이 함수를 사용하는 export target에서도 길이 제한 안에 있으면 남는다. 이슈 #1의 원래 4개 재현은 수정됐지만 그 밖의 형식까지 완전히 보호되는 것은 아니다.
- 대응: shell quoting을 고려한 처리와 JSON key-value 형식 지원 또는 자유 명령문 기본 제외를 검토하고, 부분 마스킹 없이 안전하게 실패하도록 테스트한다.

### 7. [P3] Agent Profiler / Context Inspector: 보고서·패널은 export 마스킹을 우회함

- 위치: `agent-profiler/hooks/core/profiler.ts:11–13`, `core/report.ts:48`; `context-inspector/hooks/core/report.ts:47`, `core/advice.ts:30–32,87`.
- 재현: `API_KEY=FAKE_UI_SECRET ./run.sh`를 수집하면 `/profile` slowest tool label과 `/context-inspect occupants`에 원문이 나온다. 이 형식은 export redactor에서 지원한다.
- 영향: 자체 원격 전송을 재현한 것은 아니다. 화면 공유, 보고서 복사, 캡처 시 원래 대화에 있던 비밀값을 다시 노출하는 경로다. 현재 문서의 export 마스킹 보장을 그대로 UI에 적용할 수는 없으므로 표시 정책 보완으로 분류한다.
- 대응: 분석용 원본은 유지하되 모든 display label과 advice evidence에는 자르기 전에 redactor를 적용한다. Time Machine의 isolated rerun도 원본 command를 `$ ...`로 직접 표시하므로 같은 정책 검토 대상이다.

## 모드별 범위와 결과

| 모드 | 수집·표시·보존 경로 | 결과 |
|---|---|---|
| Agent Profiler | 명령·검색 요약, report/pane/status, OTLP 파일, 설정 시 HTTP POST | 1, 4, 5, 7 |
| Context Inspector | target/compaction/분석, report/advice/pane, 명시적 JSONL export | 6, 7; 기존 이슈 #1 원래 사례는 수정됨 |
| Time Machine | 도구 입력·결과·테스트 메타데이터, JSONL, shadow Git, rerun/diff/오류 표시 | 2, 3, 4, 5; 원문 표시 정책도 검토 필요 |
| Loop Detective | 메모리의 제한된 command/cwd/path/failure 메타데이터, report/pane | 4; 자체 파일 저장·네트워크 없음 |
| Pin Memo | 명시적으로 입력한 메모, cwd+session 단위 store, 표시/저장 실패 | 같은 종류의 자동 수집·외부 export 문제는 발견하지 못함 |
| Model Effort Band | 선택 모델과 main-thread effort, AbovePrompt 표시 | 같은 종류의 명령·결과 수집, 영구 저장 또는 네트워크 경로 없음 |
| Token Run | 요청 상태, 검증된 게임 checkpoint/숫자 점수, store | 같은 종류의 인증정보 수집 문제는 발견하지 못함; 저장 실패는 고정된 안내문으로 표시 |

Pin Memo의 메모 원문 보존, Time Machine의 opt-in model response 원문 기록 및 무시하지 않은 파일 스냅샷은 명시된 기능이므로 그 자체를 버그로 세지 않았다. Pin Memo의 오류 문자열은 engine 예외 내용을 표시하므로 향후 공통 표시 정책에서 검토할 수 있으나, 실제 저장소 예외가 비밀값을 포함하는지는 이번에 입증하지 않았다. 새로운 문제가 발견되지 않았다는 결과가 보안 보증은 아니다.

## 재현과 검증

저장소 루트에서:

```sh
node --experimental-transform-types docs/verification/2026-10-17-privacy-audit.mjs
```

동봉 스크립트는 현재 노출 동작을 확인하는 **특성 검사**다. 가짜 값이 남는 사례 20개와 대조군을 검증한다. 출력의 20개는 서로 다른 취약점 20개라는 뜻이 아니며 위 7개 원인·정책 항목으로 묶었다. 마스킹이 수정되면 해당 assertion은 실패해야 하며, 이후에는 비밀값이 없어야 한다는 회귀 테스트로 바꿔야 한다. ShadowGit 검사는 시스템 임시 폴더에서 실제 Git만 사용하고 종료 시 제거한다. 나머지는 실제 core 모듈의 메모리 수집·직렬화·표시 경로를 사용하며 Claude UI를 자동 조작하거나 외부 collector에 실제 POST하지 않는다.

- 재현 스크립트: exit 0, 20개 사례 확인.
- 기존 전체 core suite: `npm test`, 328 pass / 0 fail.
- Context Inspector 0.1.1 버전 변경: TypeScript 검사 통과, Claude Code 2.1.301 엔진 테스트 99 pass / 0 fail.
- 기존 테스트 통과는 위 노출 경로가 방어됐다는 뜻이 아니다. 전체 엔진 7개 모드의 UI/HTTP end-to-end 재검증은 이번 범위에 포함하지 않았다.

권장 수정 순서: 기본 저장/전송 경로(1–3) → 누락 형식 및 마스킹 순서(4–6) → 표시 정책 통일(7). 수정 후에는 해당 모드마다 플러그인 버전을 올려 캐시된 설치본과 구분해야 한다.
