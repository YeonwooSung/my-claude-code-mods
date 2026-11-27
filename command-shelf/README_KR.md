# Command Shelf

개발 작업을 위한 로컬 Claude Code 모드입니다.

설치: `claude plugin install command-shelf@my-claude-code-mods --scope user` 실행 후 플러그인을 다시 불러옵니다.

- 도움말: `/shelf help`
- 사용법: `/shelf [list | show <id> | pin <id> <label> | run <id> | remove <id>]`
- 기록 초기화: `/shelf reset`

명령 결과는 텍스트로 표시됩니다. 폴더와 세션 ID별로 기록을 분리해 저장하고 같은 세션을 재개하면 복원합니다. 관찰 실패가 도구 실행을 막거나 재실행하지 않습니다. 외부 전송이 없고, 명백한 비밀값과 터미널 제어문자를 저장 전에 마스킹합니다.

첫 버전의 지원 범위와 한계는 [설계 문서](../docs/superpowers/specs/2026-10-17-command-shelf-design.md), 자세한 동작은 [영문 안내](README.md)를 확인하세요. 실제 터미널/Desktop 화면은 별도 확인이 필요합니다.

## 사용 예시

```text
/shelf list
/shelf pin 1 Auth regression tests
/shelf show 1
/shelf run 1
```

명령은 텍스트로 결과를 돌려줍니다. Git 분석 명령은 저장소 루트에서 사용하세요. 첫 버전에는 별도 실시간 패널이 없습니다.

성공한 포그라운드 명령을 최대 200개, UTF-8 상태 크기 240 KiB 이내로 보관합니다. 한도를 넘으면 오래된 기록부터 제거하며 남은 기록의 ID는 유지합니다. 저장 장애가 계속되면 세션에서 한 번만 경고하고, 저장이 성공하면 경고 상태를 해제합니다. `/shelf list`에서 마지막 저장 실패의 안전한 진단 정보를 확인할 수 있습니다. 호스트가 제공하는 범위에서 용량·권한·디스크·데이터 오류를 구분하며, 복구를 위해 다른 세션 기록을 삭제하지 않습니다.
