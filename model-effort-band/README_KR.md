# Model Effort Band — 모델명과 effort 표시 띠

Claude Code 입력창 바로 위에서 현재 선택 모델과 마지막으로 관측한 메인 대화의 effort를 확인합니다.

```text
Haiku 4.5  │ effort ▰▱▱▱▱ low · 빠르게       Haiku
Sonnet 4.6 │ effort ▰▰▱▱▱ medium · 보통     Sonnet
Opus 4.6   │ effort ▰▰▰▱▱ high · 깊게        Opus
```

위 예시는 세 가지 테마를 설명합니다. 실제 화면에는 현재 모델의 띠 하나만 표시됩니다. Haiku는 녹색, Sonnet은 파랑, Opus는 보라 테두리와 어두운 배경을 사용합니다. 버전은 실제 모델 ID에서 추출하며 별칭 `opus`에는 임의 버전을 붙이지 않습니다. 알 수 없는 모델은 회색으로 표시합니다.

## 설치

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install model-effort-band@my-claude-code-mods
```

저장소에서 한 세션만 로드하려면:

```sh
claude --plugin-dir ./model-effort-band
```

Mods의 기본 활성화는 Claude Code 2.1.287부터이며, 이 모드의 이벤트·렌더 API 조합은 **2.1.292에서 검증**했습니다. 이전 CLI는 업데이트 후 사용하세요. 숨기려면 `/plugin`에서 비활성화합니다. 별도 설정이나 명령은 없습니다.

## effort의 의미

- `low`, `medium`, `high`, `xhigh`, `max`를 1~5칸 게이지로 표시합니다. “빠르게·보통·깊게·더 깊게·최대로”는 effort 설명이며 실제 속도나 답변 품질을 측정한 결과는 아닙니다.
- 모델은 매 렌더에서 조회합니다. effort는 이 모드가 메인 `turn.step`에서 관측한 값만 사용하며 모델 종류나 설정에서 기본값을 추정하지 않습니다.
- 최초 effort 관측 전, 새 세션·리로드 후, 모델·설정 변경 후에는 다음 요청이 관측될 때까지 `unknown`입니다. 성공한 모든 설정 변경과 `/model`, `/effort`, `/config` 실행은 관측값을 비웁니다. 선택창을 취소해도 일시적으로 `unknown`이 될 수 있습니다.
- 요청 모델과 선택 모델의 문자열이 다르면 effort는 `unknown`입니다. 별칭과 resolved ID가 다른 경우나 자동 fallback도 포함합니다. 이 띠는 **선택 모델 표시기**이며 실제 요청 모델 이력 표시기는 아닙니다.
- 서브에이전트 요청은 메인 effort를 바꾸지 않습니다. 툴 호출·대기 중과 다음 턴에도 마지막 관측값을 유지합니다. 같은 모델의 후속 요청에서 effort가 생략되면 이전 값을 유지하고, 새 값이 전달되면 갱신합니다. 요청 모델이 달라지면 이전 값을 넘겨받지 않고 비웁니다. 숫자는 그대로 표시하고 수준을 추정하지 않습니다. 미래의 effort 문자열도 안전하게 표시합니다.
- 이 모드 뒤에 실행되는 다른 모드가 요청을 다시 쓸 수 있습니다. 띠는 그 재작성까지 확인했다고 주장하지 않습니다.

## 화면 동작

넓은 화면은 둥근 테두리 안에 모델명, effort, 오른쪽 가족 배지를 표시합니다. 폭 60칸 미만에서는 게이지·설명·배지를 생략하고, 30칸 미만 또는 사용 가능한 높이가 3행 미만이면 테두리 없는 한 줄로 축약합니다. 텍스트는 줄바꿈 대신 말줄임 처리합니다.

설문이 열리면 띠를 숨깁니다. 다른 모드의 `AbovePrompt` 결과를 보존하고 뒤에 띠를 추가합니다. 합쳐진 영역의 스크롤은 엔진이 관리합니다.

터미널·Desktop에서 사용할 수 있습니다. VS Code 채팅과 headless 모드에는 시각 띠가 없습니다. 모델 호출, 프롬프트 변경, 파일 저장, 네트워크, polling 타이머, 영구 상태는 사용하지 않습니다.

## 개발과 검증

저장소 루트에서 실행합니다:

```sh
npm test
CLAUDE_BIN=/path/to/claude-2.1.292 npm run test:adapters
npm run typecheck
/path/to/claude-2.1.292 plugin validate model-effort-band
```

타입 검사에는 엔진이 생성한 `.claude-plugin/types` 선언이 필요합니다. 이 저장소의 2.1.292 선언을 사용한다면 `agent-profiler/.claude-plugin/types`를 이 모드의 `.claude-plugin/types`로 복사합니다. 생성 선언은 Git에서 제외됩니다.

정규화, 상태 초기화, 스트리밍 청크·최종 반환값 보존, 설정 거부, 모델 조회·화면 갱신 실패, 설문, 모델별 테마와 축약 배치를 테스트합니다. 터미널·Desktop의 **렌더 트리**를 검증했으며 실제 터미널 픽셀과 Desktop 앱의 화면 검증은 아직 하지 않았습니다. 실제 터미널 확인은 작업 폴더 신뢰 확인 단계에서 중단했고 신뢰 설정은 바꾸지 않았습니다.
