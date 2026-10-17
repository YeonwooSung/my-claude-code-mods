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
