# 리뷰 발견 항목 수정 검증 — 2026-11-26

브랜치: `fix/review-findings`. 기준 커밋: `6361877`. 사용자 승인 범위는 앞선 코드 리뷰의 재현 가능한 5건이다. 설치·배포·병합은 하지 않았다.

## 수정과 근거

1. **Time Machine 복원 안전성**: Runner에서 stdout/stderr 잘림 플래그를 유지하고, Git 근거가 불완전하면 명령 결과를 사용하지 않는다. 초기화·목록·패치 읽기에도 같은 검사를 적용했다. 잘린 ignored/target 목록과 stderr는 복원·커밋·ref 변경 전에 거부된다. 실제 임시 Git 저장소에서 `.env`의 최신 무시 파일 내용이 보존되는 회귀 검사를 추가했다. 엔진 adapter에서도 플래그 전달과 원래 도구 결과 보존을 검증한다.
2. **세션 격리**: Time Machine은 모델 스트림 시작 당시 컨텍스트와 턴을 캡처한다. Context Inspector는 스트림·도구·압축·지연 사용량 갱신을 시작 원장에 묶는다. clear/resume 뒤 이전 응답·토큰·압축 결과가 새 세션 export에 들어가지 않는 엔진 회귀 검사를 추가했다.
3. **하위 폴더 경로**: 공통 runtime이 Git의 root-relative porcelain 경로를 `--show-prefix`에 따라 cwd-relative 경로로 변환한다. rename 양쪽과 이름 속 공백을 보존하고 외부 파일은 `../` 경로로 구분한다. Review Queue는 외부 파일을 `OUTSIDE`로만 표시하고 해당 파일을 읽거나 완료 표시하지 않는다. Scope Guard는 Git/관찰/기존 변경을 정규화된 같은 경로 식별자로 비교해 모순된 중복 표시를 없앴다. POSIX의 문자 backslash는 디렉터리 구분자와 구분한다.
4. **Dependency Lens 기준 파일**: `ref:./path`를 사용해 과거 manifest/lock과 현재 파일을 같은 cwd에서 읽는다. 루트와 내용이 다른 하위 패키지의 무변경·변경·삭제 상태를 실제 Git으로 검증한다.
5. **Pin Memo 저장 키**: 고정 길이 `pin-memo:v2` 해시를 사용한다. 새 키가 없을 때만 256자 이하의 기존 raw v1 키를 읽고, 이후 변경을 v2로 저장한다. 손상된 구형 문서는 명시적 clear 전까지 덮어쓰지 않는다. 긴 POSIX/Windows 경로, 256/257자 경계, 재로드와 데이터 유지 검사를 추가했다.

공통 runtime은 `node scripts/sync-workflow.mjs`로 10개 workflow mod의 독립 배포 사본에 반영했다. 이 사본을 포함해 코드가 바뀐 mod는 patch 버전을 올렸다: Time Machine 0.1.8, Context Inspector 0.1.5, Pin Memo 0.1.2, workflow mods 0.1.3. Agent Profiler 등 수정하지 않은 원본 mod 버전은 유지했다.

## 자동 검사

최종 실행 결과는 아래 표에 기록한다. 성능 제한이 있는 core/engine 검사는 서로 순차 실행한다.

| 검사 | 결과 |
|---|---|
| `npm test` | 534개 통과, 실패 0 |
| `npm run test:adapters` / CLI 2.1.302 | 17개 mod, 602개 통과, 실패 0 |
| 변경 기능 6개 mod / CLI 2.1.329 | 271개 통과, 실패 0 |
| `npm run typecheck` | 전체 17개 mod 통과 |
| `npm run test:privacy` | 통과 |
| `npm run check:workflow` | 통과 |
| 변경 mod 13개 `claude plugin validate` | 모두 종료 코드 0 |
| `git diff --check` | 통과 |

## 실제 재현 확인

- 리뷰에서 사용한 하위 패키지 fixture: 변경 없음에서 `Lock delta: +0 -0 ~0`. 외부 변경은 `OUTSIDE ../../outside.ts`, 내부 파일은 `REVIEWED a.ts`로 확인했다.
- 264자 cwd에서 실제 CLI의 `/pin review-note`: 수정 전 `key is 327 characters, over the 256 limit`, 수정 후 `메모 #1 고정`. 별도 임시 설정·예시 키·연결이 거부되는 로컬 API 주소를 사용했으며 모델 요청은 필요하지 않았다.
- 실제 Git 복원 fixture에 잘림 상태를 주입했을 때 복원이 거부되고 현재 `.env` 내용이 유지된다. 이는 출력 잘림에 대한 fault-injection 검사이며 대규모 저장소의 실제 4 MiB 출력 부하 측정은 아니다.

## 독립 검토와 한계

독립 리뷰에서 외부 파일의 Git 상대 경로와 관찰 절대 경로가 이중으로 표시되는 P2가 추가로 확인됐다. 회귀 테스트로 고정하고 경로 식별자 비교로 수정했다. 재검토에서 해당 문제가 해소됐고 좁은 변경 범위에 남은 차단 이슈가 없다는 확인을 받았다.

테스트는 정상/실패/지연 이벤트와 실제 로컬 Git 근거를 검증한다. 새 native UI 변경은 없으며 실제 앱 화면 검증이나 동시 실행의 모든 가능한 순서에 대한 증명은 아니다. 저장 키 해시는 기존 workflow mod와 같은 로컬 식별 방식이며, 여러 프로세스의 같은 메모 동시 편집 동기화를 추가하지 않는다.

이전 버전이 하위 cwd에서 저장한 scope baseline에는 형식 표식이 없어 새 상대 경로와 안전하게 구분할 수 없다. 이 경우 scope reset 후 허용 경로 재등록을 안내하며, 기존 기록을 추측해 변환하지 않는다.
