# 비밀값 노출 순차 수정 기록

기준: [검토 보고서](2026-10-17-privacy-audit.md)의 1–7번 항목. 재현 스크립트의 `protectedGroups`는 수정된 항목에서 비밀값 부재를 검사한다. 각 항목은 회귀 테스트의 실패를 확인한 다음 수정했고, 독립 플러그인 배포 구조를 유지한다. 기존에 저장·전송한 파일은 소급 정리하지 않는다.

| 항목 | 수정 및 버전 | 검증 |
|---|---|---|
| 1 | Agent Profiler 0.1.1: 검색 패턴도 `exportCommandText` opt-in 및 마스킹 적용 | core 329/329, profiler engine 60/60, TypeScript 통과 |
| 2 | Time Machine 0.1.1: staging 전에 현재 무시 파일을 shadow index에서 제외; restore 충돌 보호 유지 | core 329/329, time-machine engine 98/98, TypeScript 및 실제 Git 회귀 검사 통과 |
| 3 | Time Machine 0.1.2: 실패 테스트 이름을 parsing 단계에서 마스킹해 JSONL 우회 방지 | core 330/330, time-machine engine 99/99, TypeScript 및 저장 경로 회귀 검사 통과 |
| 4 | Agent Profiler 0.1.2 / Time Machine 0.1.3 / Loop Detective 0.1.1: 독립 배포용 redactor 복사본 동기화, 자격증명 옵션·URL·JSON 문자열 처리 및 lossy 판정 보완 | core 331/331, 각 engine 60/100/41 통과, 전체 TypeScript, 공통 corpus 39개 및 privacy 검사 통과 |
| 5 | Agent Profiler 0.1.3 / Time Machine 0.1.4: 수집·결과 요약·rerun 비교에서 마스킹 후 자르기 적용 | core 333/333, 각 engine 61/101 통과, 전체 TypeScript 및 privacy 검사 통과 |
| 6 | Context Inspector 0.1.2 / Agent Profiler 0.1.4 / Time Machine 0.1.5 / Loop Detective 0.1.2: shell 헤더의 escaped quote 및 JSON 자격증명 필드 처리, 네 모드 동기화 | core 335/335, 각 engine 101/61/101/41 통과, 전체 TypeScript, 공통 corpus 68개 및 privacy 검사 통과 |
| 7 | Agent Profiler 0.1.5 / Context Inspector 0.1.3 / Time Machine 0.1.6: 보고서·pane·status·advice·rerun 안내에서 마스킹 후 자르기, 실행 원문 보존 | core 338/338, 전체 engine 443/443 (62+102+103+41+29+56+50), 전체 TypeScript 및 privacy 20/20 통과 |

## 최종 상태

검토 항목 1–7을 순서대로 수정했다. 각 행은 해당 시점의 버전과 검증 결과이며, 모드가 여러 항목에 포함되면 버전도 단계별로 올렸다. 최종 버전은 Agent Profiler 0.1.5, Context Inspector 0.1.3, Time Machine 0.1.6, Loop Detective 0.1.2다. 나머지 세 모드는 제품 코드를 변경하지 않았다.

`npm test`, `npm run typecheck`, `npm run test:privacy` 및 Claude Code 2.1.301의 전체 `npm run test:adapters`가 통과했다. 공통 마스킹 corpus는 17개 × 4개 모드 = 68개이며, 원래 검토의 20개 재현은 모두 비밀값 부재를 확인한다. 실제 Git 검사는 새 비밀값이 최종 tree뿐 아니라 loose object에도 기록되지 않고, 복원이 현재 무시 파일을 덮어쓰지 않는지 확인한다. 추가 엔진 검사는 표시를 마스킹한 후에도 실제 재실행 도구에는 원래 입력이 전달되는지 확인한다.

예외 메시지를 던지는 엔진 mock은 원래 문자열을 `no implementation`으로 바꿔 반환하므로 비밀값 마스킹의 증거가 되지 않았다. 해당 가정에 의존한 임시 검사는 제거하고, 실제 노출이 재현된 출력 경로와 재실행 입력 보존을 검증했다. 엔진 UI 렌더 트리 테스트는 실제 화면 캡처나 외부 OTLP 서버 전송을 검증한 것은 아니다.

기존 저장 파일, 과거 shadow Git 객체, opt-in 모델 응답 원문 기록은 소급 정리하지 않는다. 마스킹은 알려진 형식을 다루며 모든 비밀값의 탐지를 보증하지 않는다. GitHub 게시·푸시도 수행하지 않았다.
