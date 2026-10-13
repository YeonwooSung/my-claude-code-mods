# Pin Memo

Claude Code 입력창 위에 메모와 체크리스트를 고정합니다. 같은 폴더에서 **같은 세션을 재개**하면 내용과 완료 상태가 복원됩니다.

## 설치

Claude Code 2.1.292의 엔진 테스트와 타입으로 검증했습니다. 터미널과 Desktop의 AbovePrompt를 사용하며, VS Code 채팅과 headless에서는 명령·저장 기능만 사용합니다.

```sh
claude plugin marketplace add YeonwooSung/my-claude-code-mods
claude plugin install pin-memo@my-claude-code-mods
```

현재 저장소에서 한 세션에 로드하려면:

```sh
claude --plugin-dir ./pin-memo
```

## 사용

```text
/pin 변경 전 테스트 확인
/pin - [ ] 배포 전 .env 키 확인
/pin - [x] 문서 업데이트
/pin toggle 2
/pin check 2
/pin uncheck 2
/pin edit 2 - [ ] 프로덕션 배포 확인
/pin remove 1
/pin list
/pin clear
/pin help
```

`/pin`만 실행하면 전체 내용과 번호를 보여줍니다. `help`, `clear` 등 예약어로 시작하는 메모는 `/pin add clear ...`로 추가하세요. 체크 마커 없이 edit하면 일반 메모로 바뀝니다. 여러 줄 내용은 메모 하나로 저장하며, 고정 영역에서는 한 줄로 표시합니다.

청록색 둥근 테두리 안에 핀 개수·완료 개수를 표시합니다. 완료 항목은 흐리게 취소선으로 표시하고 삭제하지 않습니다. 체크 버튼을 클릭하거나 `ctrl+x tab`으로 밴드에 포커스를 이동한 후 Tab/Enter로 상태를 전환할 수 있습니다. 번호 단축키는 입력창의 숫자 입력과 충돌하지 않도록 사용하지 않습니다. 접기·스크롤은 엔진의 기본 기능을 사용합니다. 좁은 화면에서는 표시만 축약하며 원문은 유지합니다. 설문이 같은 영역을 사용하는 동안에는 메모 표시가 잠시 숨겨집니다.

## 저장과 제한

- 엔진의 플러그인 전용 `$.store`에 저장합니다. 저장 키는 폴더 절대 경로와 세션 ID의 조합입니다.
- `/clear` 또는 같은 폴더의 새 세션은 별도 목록입니다. 이전 세션을 재개하면 이전 목록이 돌아옵니다. 심볼릭 링크를 통해 다른 경로로 연 폴더도 별도 목록입니다.
- 각 변경을 즉시 저장하며, 저장 실패 시 이전 내용·체크 상태를 유지하고 오류를 표시합니다. 손상된 데이터는 자동으로 덮어쓰지 않습니다. `/pin clear`로 현재 목록을 명시적으로 초기화할 수 있습니다.
- 최대 100개 항목, 항목당 2,000 Unicode 코드 포인트입니다. 삭제된 번호를 재사용하지 않습니다. 플러그인 저장소 전체 한도는 엔진 기준 4 MiB입니다. 저장 데이터는 자동 만료되지 않습니다.
- 같은 세션을 여러 프로세스에서 동시에 편집하는 경우 실시간 동기화·충돌 방지를 보장하지 않습니다.
- 메모를 모델 입력에 자동 주입하지 않습니다. 프롬프트나 프로젝트 파일을 수정하지 않습니다.

## 개발·검증

```sh
npm test
CLAUDE_BIN=/path/to/claude-2.1.292 npm run test:adapters
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 /path/to/claude-2.1.292 plugin test pin-memo
/path/to/claude-2.1.292 plugin validate pin-memo
npm run typecheck
```

타입 검사는 로컬 `.claude-plugin/types`에 2.1.292의 선언 파일이 필요합니다. 이 작업의 Pin Memo 검사에는 같은 버전이 기존 모드에 생성한 선언 파일을 복사해서 사용했습니다. 생성 타입은 커밋하지 않습니다.

코어 테스트는 명령·문서 검증, 저장 실패와 비동기 경합, Unicode 폭 처리를 검증합니다. 엔진 테스트는 터미널·Desktop의 렌더 트리 및 Button press를 검증합니다. 실제 터미널·Desktop의 픽셀 캡처 검증은 수행하지 않았습니다.
