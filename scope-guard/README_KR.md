# Scope Guard

개발 작업을 위한 로컬 Claude Code 모드입니다.

설치: `claude plugin install scope-guard@my-claude-code-mods --scope user` 실행 후 플러그인을 다시 불러옵니다.

- 도움말: `/scope help`
- 사용법: `/scope [allow <path> | list | reset]`
- 기록 초기화: `/scope reset`

명령 결과는 텍스트로 표시됩니다. 폴더와 세션 ID별로 기록을 분리해 저장하고 같은 세션을 재개하면 복원합니다. 관찰 실패가 도구 실행을 막거나 재실행하지 않습니다. 외부 전송이 없고, 명백한 비밀값과 터미널 제어문자를 저장 전에 마스킹합니다.

첫 버전의 지원 범위와 한계는 [설계 문서](../docs/superpowers/specs/2026-10-17-scope-guard-design.md), 자세한 동작은 [영문 안내](README.md)를 확인하세요. 실제 터미널/Desktop 화면은 별도 확인이 필요합니다.
