# Model Effort Band — 설계 스펙

- 작성일: 2026-10-13 (Asia/Seoul)
- 상태: 사용자 승인 후 구현·자동 검증·독립 코드 리뷰 완료.
- 모드명 / 위치: `model-effort-band` / `model-effort-band/`
- 목적: Claude Code 입력창 위에서 현재 모델과 메인 대화의 effort를 한눈에 확인한다.
- 디자인 근거: 사용자가 첨부한 모델별 녹색·파랑·보라 테두리 띠. 이미지의 `5.5`는 예시이며 실제 모델의 버전을 표시한다.

## 1. 요구 해석과 선택

이미지의 세 줄은 모델별 스타일 예시로 해석한다. 실제 화면에는 현재 모델의 띠 하나만 표시한다. 모델이나 effort를 변경하는 컨트롤은 추가하지 않는다.

대안 비교:

| 방식 | 장점 | 비용 |
|---|---|---|
| 입력창 위 `AbovePrompt` 띠 (선택) | 참조 이미지의 배치와 테두리를 재현하고 입력 전에도 보인다 | 터미널에서 테두리가 두 행을 추가로 차지한다 |
| 기존 상태줄 | 공간 소비가 적다 | 테두리·우측 배지를 구현하기 어렵고 다른 모드의 상태줄과 자리를 공유한다 |
| 별도 Pane | 자세한 정보를 담기 쉽다 | 단순 상태 확인에 패널을 여는 동작이 필요하다 |

## 2. 표시 계약

넓은 화면의 형식:

```text
╭──────────────────────────────────────────────────────────────╮
│ Sonnet 4.6 │ effort ▰▰▱▱▱ medium · 보통              Sonnet │
╰──────────────────────────────────────────────────────────────╯
```

실제 칸 수는 엔진이 제공하는 `bodyColumns`를 기준으로 계산한다. 위 도식의 간격은 설명용이다.

- Haiku: 녹색 `#8ACFA7`, 어두운 배경 `#17251F`.
- Sonnet: 파랑 `#8BBEF4`, 어두운 배경 `#192333`.
- Opus: 보라 `#B99CE5`, 어두운 배경 `#241C32`.
- 알 수 없는 모델: 회색 `#B5BAC4`, 어두운 배경 `#202329`, 배지 `Model`.
- `low` → `▰▱▱▱▱`, `빠르게`, 녹색.
- `medium` → `▰▰▱▱▱`, `보통`, 파랑.
- `high` → `▰▰▰▱▱`, `깊게`, 노랑 `#E4CC75`.
- `xhigh` → `▰▰▰▰▱`, `더 깊게`, 노랑.
- `max` → `▰▰▰▰▰`, `최대로`, 노랑.
- 숫자 effort: 유한한 0 이상의 숫자 그대로 표시하고 게이지·수준 설명은 생략한다. 숫자의 의미를 임의로 등급화하지 않는다.
- 미관측·누락·유효하지 않은 effort: `unknown · 확인 전`, 게이지 없음.
- 알 수 없는 문자열 effort: 안전하게 정리한 원래 문자열, 게이지·수준 설명 없음.
- effort 설명은 수준을 이해하기 위한 문구이며 응답 속도나 품질에 대한 측정·보장이 아니다.
- 모든 모델 × 모든 effort 조합을 허용한다. 모델 종류에서 effort를 추정하지 않는다.

### 모델명 정규화

- `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001` → `Sonnet 4.6`, `Opus 4.6`, `Haiku 4.5`.
- `claude-3-5-sonnet-20241022` 같은 이전 이름도 `Sonnet 3.5`로 표시한다.
- 별칭 `haiku`, `sonnet`, `opus`는 버전을 붙이지 않고 가족명만 표시한다.
- Bedrock 지역 접두사, `anthropic.` 접두사, 날짜와 `:vN` 접미사가 있는 알려진 Claude ID도 가족·버전을 추출한다.
- 임의 문자열 중간에 `opus`가 있다는 이유로 Claude 모델로 판정하지 않는다. 알려진 Claude ID 형식과 별칭에만 가족 색을 적용한다.
- 알 수 없는 모델은 제어 문자 제거, 공백 정리 후 최대 80 Unicode 코드 포인트까지만 표시한다. 빈 값은 `Unknown model`이다.
- 모델 별칭을 특정 최신 버전으로 변환하는 고정 표나 원격 조회는 사용하지 않는다.

### 공간과 접근성

- `bodyColumns >= 60`, `maxRows >= 3`: 둥근 테두리, 모델명, effort 게이지·영문 수준·한국어 설명, 오른쪽 가족 배지.
- `30 <= bodyColumns < 60`, `maxRows >= 3`: 테두리, 모델명과 `effort <값>`만 표시한다.
- `bodyColumns < 30` 또는 `maxRows < 3`: 한 줄의 `모델명 | effort <값>`으로 축약한다. 공간이 없으면 띠를 생략한다.
- 텍스트는 말줄임 처리하고 줄바꿈하지 않는다. 출력 폭이 영역 폭을 넘지 않는다.
- 한글은 두 셀, ASCII·게이지는 한 셀로 계산한다. 알려진 모델명의 배치는 정확히 계산하고 임의 Unicode 이름은 renderer의 말줄임을 최종 경계로 사용한다.
- 색 없이도 모델명·effort 문자열로 의미를 읽을 수 있다.
- `hasSurvey === true`이면 띠를 그리지 않고 `next(e)`를 그대로 반환한다.
- 다른 `AbovePrompt` 모드의 `next(e)` 결과를 보존하고 그 뒤에 자신의 띠를 추가한다. 다른 모드와 전체 공간을 조율하는 기능은 엔진에 맡긴다.

## 3. 데이터의 의미와 수명

현재 선택 모델은 `$.session.model()`로 읽는다. 첫 요청 전에도 모델명은 표시할 수 있다. 이 호출이 실패하면 해당 렌더는 `Unknown model`과 `unknown` effort를 표시하며 이전 모델을 재사용하지 않는다.

effort의 신뢰 가능한 입력은 메인 대화의 `turn.step`에서 받은 `e.effort`이다. 모드가 등록된 순서에서 관측한 요청 값이며, 뒤에 실행되는 다른 모드의 재작성까지 확인했다고 주장하지 않는다. 설정값을 읽어 기본 effort를 추정하지 않는다.

상태는 register 호출마다 생성한 하나의 `BandState` 인스턴스에 저장한다:

- `observeStep({ model, effort, agentId })`: `agentId`가 없을 때만 모델과 effort를 교체한다. effort 누락도 교체하므로 이전 값이 남지 않는다.
- `reset()`: 관측 모델·effort를 모두 비운다.
- `snapshot(selectedModel)`: 현재 선택 모델과 관측 모델의 문자열이 같은 경우에만 관측 effort를 반환한다. 모델 별칭과 resolved ID가 다르면 안전하게 `unknown`으로 표시한다.
- `session.start`, `session.end`, 메인 `turn.start`에서 reset한다. `/clear`, resume, reload 뒤에도 이전 상태가 남지 않는다.
- `classic.PostModelSwitch`에서 reset하고 invalidate한다.
- 성공한 `config.set` 뒤에 reset하고 invalidate한다. 설정 키 목록에 의존하지 않기 위해 모든 성공한 설정 변경에서 관측 effort를 무효화한다. 거부된 변경은 상태를 유지한다.
- `command.run`의 `model`, `effort`, `config`를 통과시킨 뒤 reset하고 invalidate한다. 설정 UI가 취소되어도 다음 요청까지 effort가 `unknown`인 보수적인 동작을 허용한다.
- 성공한 session/turn 경계와 메인 step 관측 뒤에 `$.ui.invalidate('ui.render')`를 호출한다. 별도 타이머와 polling은 사용하지 않는다.

자동 fallback 때문에 요청 모델과 선택 모델이 다르면 선택 모델을 표시하고 effort는 `unknown`이다. v1은 선택 모델 표시기이며 실제 요청 모델 이력 표시기는 아니다.

## 4. 아키텍처와 환경

기존 모드처럼 순수 TypeScript 코어와 얇은 엔진 어댑터를 분리한다.

```text
model-effort-band/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx       # 이벤트 관측, 렌더 조합, 실패 격리
  hooks/core/band.ts       # 모델/effort 정규화, 관측 상태, 폭별 표시 데이터
  tests/band.test.ts       # Node와 엔진에서 실행 가능한 순수 코어 테스트
  tests/adapter.test.ts    # 실제 엔진 테스트 키트로 이벤트·렌더 계약 검증
  tsconfig.json
  README.md
  README_KR.md
```

- 새 의존성은 추가하지 않는다.
- Node 코어 검증: Node 22.19.0 이상, 기존 loader와 `expect` 사용.
- 엔진 검증 기준: 로컬 Claude Code 2.1.292의 생성 타입과 바이너리. 기본 Mods 지원 하한은 2.1.287이지만 이 모드의 API 조합 호환성은 2.1.292 검증 결과를 기준으로 안내한다.
- 터미널과 Desktop의 `AbovePrompt` 지원. VS Code 채팅과 headless 모드에는 시각 띠가 없다.
- 프로세스 실행, 네트워크, 파일 I/O, 모델 호출, 프롬프트 수정, 설정 수정, persistence 없음.
- 설정 옵션이나 토글 명령은 v1에 추가하지 않는다. 플러그인 관리 화면에서 비활성화할 수 있다.

## 5. 실패 처리와 테스트 기준

관측 훅은 이벤트·스트림·최종 반환값을 변경하지 않는다. invalidate 실패를 격리하고 후속 이벤트를 정상 진행한다. downstream 실행 오류는 그대로 전파하며, 오류 뒤에 `next`를 다시 실행하지 않는다. 렌더 구축 실패는 이미 얻은 downstream 트리를 반환한다.

완료 조건:

1. 모델명 형식, 모델/effort 조합, 누락·임의값·제어 문자를 코어 테스트로 검증한다.
2. 폭 0/1/29/30/59/60과 행 수 0/1/2/3에서 레이아웃 전환을 검증한다.
3. 서브에이전트 격리, 모델 변경, effort 누락, 세션 reset을 검증한다.
4. 실제 엔진 키트로 스트리밍 청크와 generator 최종 결과가 보존되는지 검증한다.
5. 실제 엔진 키트로 survey pass-through, 다른 모드 트리 보존, 조회·invalidate 실패와 설정 변경 거부를 검증한다.
6. `npm test`, 엔진 모드 테스트, typecheck, plugin validate를 실행한다. 기존 테스트 실패도 빠짐없이 보고한다.
7. 터미널과 Desktop의 실제 캡처 검증 여부를 문서와 완료 보고에서 구분한다. 렌더 트리 테스트만으로 화면 검증을 주장하지 않는다.
8. 설계/계획, 코어, 어댑터, 설치 통합 단위로 커밋하며 기존 `loop-detective` 작업은 포함하지 않는다.

## 6. 근거와 현재 기준선

- 공식 가이드: https://code.claude.com/docs/en/plugins/mods/create
- 공식 API 참조: https://code.claude.com/docs/en/plugins/mods/reference
- 로컬 근거: `agent-profiler/.claude-plugin/types/claude-code/index.d.ts`의 `TurnStepInput`, `AbovePrompt`, `session.model`, `config.set`, `PostModelSwitch`, `BoxProps`.
- 구현 전 `npm test`: 199개 통과, 실패 0 (2026-10-13).
- 현재 기본 `claude`: 2.1.280. 검증에는 설치되어 있는 VS Code 확장의 2.1.292 바이너리를 명시적으로 사용한다.

## 7. 구현 검증 기록 (2026-10-14)

- 기능 브랜치: `feat/model-effort-band`. 동시 진행 중인 작업을 보호하기 위해 독립 worktree에서 구현했다.
- TDD: 코어 빈 구현을 38개 테스트로 실행해 기능 부재에 따른 assertion 실패를 확인한 뒤 구현했다. 어댑터는 빈 register에서 표시 테스트의 실패를 확인했다. 리로드 초기화와 텍스트 인접 배치는 결함을 제거/재현한 RED→GREEN 회귀 테스트로 추가 검증했다.
- 코어 테스트: 총 237개 (새 모드 38개 포함), 실패 0. Node 22.19.0에서도 237개 전부 통과했다.
- 엔진 테스트: 2.1.292에서 총 291개 (59 + 78 + 98 + 새 모드 56), 실패 0.
- 전체 모드 typecheck 및 새 모드 plugin validate 통과.
- 실제 화면: CLI의 작업 폴더 신뢰 확인 단계에서 중단했다. 신뢰 설정을 바꾸지 않았으며 터미널 픽셀·Desktop 실제 화면은 미검증이다.
- 계획 보정: 2.1.292의 `turn.start`는 `agentId`가 없는 메인 턴 이벤트이므로 조건 없이 초기화한다. downstream 훅 오류는 엔진이 `HooksError`로 변환하므로 원문 오류 문자열 대신 실패 전달과 실행 한 번을 검증한다.

### 최종 코드 리뷰

- 독립 리뷰어 결과: Critical 0, Important 0. 새 코어 38개를 별도로 실행해 모두 통과했다.
- Minor 문서 지적: 렌더 실패 전체를 검증했다는 표현을 실제 테스트 대상인 모델 조회·화면 갱신 실패로 좁혔다. `ui.resolve`/요소 생성 실패 분기와 downstream `ui.render` 거부는 전용 테스트가 없다.
- 실제 터미널·Desktop 픽셀, 임의 Unicode 말줄임, 여러 모드가 동시에 표시되는 화면은 미검증이다. 코드와 엔진 타입이 보장하는 폭 제한·말줄임·트리 보존 및 스크롤 계약을 사용하며 실제 화면 확인 시 재평가한다.
- 최종 브랜치는 `feat/model-effort-band`에 보존한다. 다른 작업이 진행 중인 `main`에 대한 통합과 원격 push는 별도 선택 후 수행한다.
