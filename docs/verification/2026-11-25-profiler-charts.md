# Agent Profiler 0.1.8 차트 검증

검증일: 2026-11-25 (Asia/Seoul). 범위: 현재 checkout의 제품 코드와 테스트. 설치·배포·커밋은 수행하지 않았다.

## 구현 내용

`/profile-pane`에 전체 세션의 배타적 시간 구성, 최근 최대 12턴의 시간 비교, 느린 개별 호출 5개의 막대를 추가했다. 터미널은 Raster, Desktop/VS Code는 정적 SVG를 사용한다. 폭 40열/본문 높이 8행 미만이면 기존 텍스트를 표시한다. 기존 보고서·상태줄·OTLP의 시간 의미를 유지하고 새로운 통신·데이터 수집·저장은 추가하지 않았다.

`analyze.ts`의 기존 attribution 결과를 턴별로 재사용한다. 최근 행과 slowest의 running 상태를 기존 500ms 캐시에 포함한다. 레이블은 마스킹 후 Unicode 코드 포인트 단위로 제한하고 SVG XML을 이스케이프한다. SVG 라벨은 시간값과 분리해서 자르므로 긴 경로가 수치를 덮지 않는다.

## 자동 검증

| 검사 | 결과 |
|---|---|
| `npm test` | 코어 522개 통과, 실패 0 |
| `npm run test:adapters` / CLI 2.1.302 | 17개 mod 총 589개 통과, 실패 0 |
| Profiler 엔진 테스트 / CLI 2.1.329 | Profiler 101개 통과, 실패 0 (단독 실행) |
| `npm run typecheck` | 전체 17개 mod 통과 |
| `npm run test:privacy` | 공통 마스킹 코퍼스와 기존 실제 Git 개인정보 회귀 검사 통과 |
| `claude plugin validate agent-profiler` / 2.1.302 | 통과; 기존 managed-event/gating 안내 출력 |
| 같은 validate / 2.1.329 | 경고 포함 통과. 파일별 검사에서 기존 `.ts` 확장자 import 방식의 TS5097 경고가 출력됨. 프로젝트 tsc의 allowImportingTsExtensions 설정과 실제 엔진 테스트는 통과 |
| `git diff --check` | 통과 |

추가 테스트는 병렬 attribution, 최근 12개 제한, 부분 보관 범위, 0값·비유한 값, live 캐시, 최대 나머지 반올림, Raster의 little-endian 셀, SVG 마스킹·이스케이프·긴 라벨, 세 surface 렌더 트리, 리사이즈 경계, 렌더링 중 I/O 없음, StopFailure 후 정지 및 새 세션 ID 초기화를 다룬다.

20k-span / 2000-turn의 기존 200ms 성능 한도는 변경하지 않았다. 엔진·개인정보 검사를 병렬 실행한 2.1.329 검사에서 이 한도만 한 번 실패했다(347ms). 다른 작업 종료 후 단독 재실행에서는 100개 모두 통과했다. 이후 lifecycle 통합 테스트를 추가한 최종 단독 실행에서는 101개 모두 통과했다.

## 화면 검증 범위

| 대상 | 확인한 범위 |
|---|---|
| Terminal | 실제 엔진이 생성한 Raster 트리·셀 데이터·갱신·리사이즈. native 앱 픽셀은 미검증 |
| Desktop / VS Code | 각 surface의 엔진 렌더 트리·정적 SVG·초기화. native 앱 픽셀은 미검증 |
| 생성 SVG의 브라우저 표시 | 고정 fixture의 세 턴·느린 호출·running·누락 기록을 렌더하고 스크린샷을 직접 확인. 한국어가 섞인 긴 호출명과 오른쪽 시간값 분리 확인 |

실제 terminal 화면을 확인하려고 CUA에서 iTerm2에 접근했지만 도구가 안전 정책상 접근을 거부했다. 해당 앱의 접근 제한은 우회하지 않았다. 브라우저에서 SVG를 확인한 결과를 Claude Desktop/VS Code의 실제 화면 검증으로 간주하지 않는다. 앱별 표시, 스크롤과 Esc 조작은 사용자 환경에서 추가 확인이 필요하다.

## 재현

```sh
npm test
npm run test:adapters
npm run typecheck
npm run test:privacy
claude plugin test agent-profiler
claude plugin validate agent-profiler
```

두 번째 엔진은 해당 바이너리로 `plugin test agent-profiler`와 `plugin validate agent-profiler`를 별도로 실행한다. 성능 테스트를 포함하는 검사들은 CPU 경합을 피하도록 순차 실행한다.

실제 사용 확인:

```sh
claude --plugin-dir ./agent-profiler
```

세션에서 작업 후 `/profile-pane`을 입력한다. 작은 화면에서는 텍스트 표시가 정상이다. `/profile`은 기존 숫자 보고서를 제공하며, 차트의 model은 내부 연산 시간이 아닌 응답 대기 시간이다.

## 검토와 작업 상태

독립 리뷰를 요청했으나 리뷰 에이전트가 계정 사용량 제한으로 실행되지 못했다. 따라서 독립 리뷰가 완료됐다는 주장은 하지 않는다. 작성자가 새 파일과 전체 diff를 직접 점검하고, 극단값과 513개 폭에 대한 셀 배분 불변 조건도 별도 확인했다.

현재 샌드박스는 `.git` ref 쓰기를 허용하지 않아 브랜치 생성·커밋이 불가능했다. 작업은 현재 checkout에 남겼으며 기존 사용자 변경은 보존했다. 변경된 제품 범위는 agent-profiler에 한정되고, 다른 mod는 수정하지 않았다.
