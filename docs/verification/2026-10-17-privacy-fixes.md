# 비밀값 노출 순차 수정 기록

기준: [검토 보고서](2026-10-17-privacy-audit.md)의 1–7번 항목. 재현 스크립트의 `protectedGroups`는 수정된 항목에서 비밀값 부재를 검사한다. 각 항목은 회귀 테스트의 실패를 확인한 다음 수정했고, 독립 플러그인 배포 구조를 유지한다. 기존에 저장·전송한 파일은 소급 정리하지 않는다.

| 항목 | 수정 및 버전 | 검증 |
|---|---|---|
| 1 | Agent Profiler 0.1.1: 검색 패턴도 `exportCommandText` opt-in 및 마스킹 적용 | core 329/329, profiler engine 60/60, TypeScript 통과 |
