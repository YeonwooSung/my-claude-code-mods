# Model Effort Band Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. No per-task subagent delegation is needed.

**Goal:** 현재 선택 모델과 관측한 메인 effort를 참조 이미지의 입력창 위 띠로 표시한다.

**Architecture:** 순수 코어가 표시 데이터와 상태를 만든다. 어댑터가 엔진의 모델 조회·요청 이벤트를 연결하고 다른 모드의 트리와 함께 렌더링한다. 설치 통합은 기존 마켓플레이스와 테스트 runner를 확장한다.

**Tech Stack:** TypeScript/TSX, Claude Code 2.1.292 Mods API, Node 22.19.0, 기존 engine testing/Node loader. 새 패키지 없음.

**Spec:** `docs/superpowers/specs/2026-10-13-model-effort-band-design.md`

**Status:** 사용자 승인 후 Task 1–3 구현·검증·독립 코드 리뷰 완료. 기능 브랜치에 보존.

## Global Constraints

- 새 의존성은 추가하지 않는다.
- 터미널과 Desktop의 `AbovePrompt` 지원. VS Code 채팅과 headless 모드에는 시각 띠가 없다.
- 프로세스 실행, 네트워크, 파일 I/O, 모델 호출, 프롬프트 수정, 설정 수정, persistence 없음.
- 설정 옵션이나 토글 명령은 v1에 추가하지 않는다.
- 모든 모델 × 모든 effort 조합을 허용한다. 모델 종류에서 effort를 추정하지 않는다.
- 기존 `loop-detective` 파일 및 미커밋 문서는 변경하거나 커밋에 포함하지 않는다.

## Review Focus

1. 별칭·이전 ID·Bedrock ID는 버전을 정확히 추출하고 임의 이름은 가족을 오판하지 않는다.
2. 누락 effort, 다른 모델, reset 이후에는 이전 effort가 표시되지 않는다.
3. 서브에이전트의 step은 메인 상태에 영향을 주지 않는다.
4. 좁은 화면·행 부족·survey에서 입력 영역과 다른 모드 트리를 보존한다.
5. downstream 실패·조회 실패·설정 거부 때 실행을 반복하거나 잘못된 상태를 표시하지 않는다.

## 실행 준비

- [x] 스펙의 표시 의미·배치·scope를 검토하고 확정한다.
- [x] 작업 격리 방식을 확정한다. worktree 사용 시 원본 미커밋 파일을 이동하지 않는다. 같은 checkout 사용 시 기능 브랜치를 만들고 경로별로 staging한다.
- [x] `npm test`로 기준선을 재확인한다. 작성 시점에는 199개 통과했다.
- [x] 로그에 각 단위의 RED/GREEN 명령, 결과, 커밋 해시를 남긴다.

## Task 1: 순수 코어 — 표시 데이터와 관측 상태

**Files:** `model-effort-band/hooks/core/band.ts`, `model-effort-band/tests/band.test.ts`

**Interfaces:**

```ts
export type Family = 'haiku' | 'sonnet' | 'opus' | 'unknown'
export type ModelView = { name: string; family: Family; badge: string; color: string; background: string }
export type EffortView = { value: string; meter: string; description: string; color: string }
export type BandView = { model: ModelView; effort: EffortView; layout: 'full' | 'compact' | 'inline' | 'hidden' }
export function modelView(model: unknown): ModelView
export function effortView(effort: unknown): EffortView
export function bandView(model: unknown, effort: unknown, columns: number, rows: number): BandView
export class BandState {
  observeStep(step: { model: string; effort?: unknown; agentId?: string }): void
  reset(): void
  snapshot(selectedModel: string): { model: string; effort: unknown }
}
```

- [x] **RED: 정규화와 상태 테스트부터 작성한다.** 잘못된 가족 추출, 이전 effort 유지, 서브에이전트 상태 덮어쓰기가 각 테스트를 실패시켜야 한다. 기대값은 hand-written literals로 둔다.

```ts
import { expect, test } from 'claude-code/testing'
import { BandState, bandView, effortView, modelView } from '../hooks/core/band.ts'

test('extracts current and legacy model versions without inventing alias versions', () => {
  expect(modelView('claude-sonnet-4-6').name).toBe('Sonnet 4.6')
  expect(modelView('claude-haiku-4-5-20251001').name).toBe('Haiku 4.5')
  expect(modelView('claude-3-5-sonnet-20241022').name).toBe('Sonnet 3.5')
  expect(modelView('us.anthropic.claude-opus-4-6-v1:0').name).toBe('Opus 4.6')
  expect(modelView('opus').name).toBe('Opus')
  expect(modelView('my-opus-proxy').family).toBe('unknown')
})

test('unknown inputs cannot leak terminal control characters', () => {
  expect(modelView('\u001b[31mcustom\nmodel').name).not.toContain('\u001b')
  expect(modelView('').name).toBe('Unknown model')
  expect(effortView(Number.NaN).value).toBe('unknown')
  expect(effortView(-1).value).toBe('unknown')
  expect(effortView(42).value).toBe('42')
  expect(effortView(42).meter).toBe('')
})

test('effort comes from the main request and is cleared when absent or changed', () => {
  const state = new BandState()
  state.observeStep({ model: 'opus', effort: 'low' })
  state.observeStep({ model: 'haiku', effort: 'max', agentId: 'a1' })
  expect(state.snapshot('opus').effort).toBe('low')
  expect(state.snapshot('sonnet').effort).toBeUndefined()
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBeUndefined()
  state.observeStep({ model: 'opus', effort: 'high' })
  state.reset()
  expect(state.snapshot('opus').effort).toBeUndefined()
})

test('layout respects body width and rows', () => {
  expect(bandView('opus', 'high', 60, 3).layout).toBe('full')
  expect(bandView('opus', 'high', 59, 3).layout).toBe('compact')
  expect(bandView('opus', 'high', 30, 3).layout).toBe('compact')
  expect(bandView('opus', 'high', 29, 3).layout).toBe('inline')
  expect(bandView('opus', 'high', 60, 2).layout).toBe('inline')
  expect(bandView('opus', 'high', 1, 1).layout).toBe('inline')
  expect(bandView('opus', 'high', 0, 3).layout).toBe('hidden')
  expect(bandView('opus', 'high', 60, 0).layout).toBe('hidden')
})
```

- [x] 명령 실행 후 새 기능 부재 때문에 실패하는지 확인한다:

```sh
node --experimental-transform-types --import ./scripts/core-loader.mjs --test model-effort-band/tests/band.test.ts
```

- [x] **GREEN:** `modelView`에 알려진 Claude ID 형식만 허용하는 정규식과 제어 문자 정리를 구현한다. `effortView`는 스펙의 다섯 문자열만 게이지로 변환한다. `BandState`는 register별 단일 관측값을 보관하고 엄격한 모델 문자열 일치 때만 effort를 반환한다.
- [x] 각 모델 가족 × 다섯 effort, 미관측값, 미래 effort 문자열, 80자 상한, `NaN`/무한대 폭, 숫자 effort의 경계에 대해 같은 RED→GREEN 사이클을 반복한다. 비유한 폭·행 수는 0으로 정규화한다.
- [x] 녹색이 된 뒤 중복된 표시 문자열 정리 로직을 추출하고 테스트를 다시 실행한다.
- [x] 전체 기존 `npm test`도 실행한 후 코어 단위를 커밋한다:

```sh
git add model-effort-band/hooks/core/band.ts model-effort-band/tests/band.test.ts
git commit -m "feat(model-effort-band): normalize model and effort display state"
```

## Task 2: 엔진 어댑터 — 투명한 관측과 반응형 띠

**Files:** `model-effort-band/hooks/register.tsx`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, `tsconfig.json`, `tests/adapter.test.ts`, `.gitignore`

**Consumes:** Task 1의 `BandState`, `bandView`.

**Produces:** `export const register: Register`와 설치 가능한 독립 mod.

- [x] 테스트 실행에 필요한 manifest (`name: model-effort-band`, `version: 0.1.0`, 설정 없음), `modules: ["./register.tsx"]`, 기존 모드와 동일한 tsconfig를 작성한다. 생성 타입 디렉터리는 `.gitignore`에 추가한다. 제품 코드는 아직 작성하지 않는다.
- [x] **RED:** 실제 `claude-code/testing`으로 아래 주요 동작을 검증한다. 렌더 fixture는 2.1.292 생성 타입의 전체 `AbovePrompt` props를 채운다. 타입 검사를 우회하는 불완전 fixture를 만들지 않는다.

```ts
import { expect, test } from 'claude-code/testing'

test('wraps downstream AbovePrompt content instead of replacing it', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-4-6' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['other-mod'] }))
  const render = await $.ui.render({
    component: 'AbovePrompt', surface: 'terminal', requestId: 'band',
    viewport: { columns: 100, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 95,
      scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const content = JSON.stringify(render)
  expect(content).toContain('other-mod')
  expect(content).toContain('Opus 4.6')
  expect(content).toContain('unknown')
})
```

이 fixture는 로컬 2.1.292 선언의 `RenderInputOf`, `SiteScroll`, `SiteView`를 기준으로 작성했다. 엔진이 생성한 타입을 사용해 불일치를 발견하며 `as never`로 숨기지 않는다.

- [x] 테스트를 실행해 “띠가 없다”는 assertion failure를 확인한다. 최초 module discovery에는 빈 `register`만 사용한다.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 /Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin test model-effort-band
```

- [x] **GREEN:** `register` 내부에 상태를 만든다. lifecycle/step 훅은 `next(e)`를 한 번만 호출한다. step의 완전한 통과는 `return yield* next(e)`를 사용한다. 모델/config 변경 결과를 받은 뒤 상태를 비우고 invalidate 실패는 관측 실패로 격리한다.

```ts
const state = new BandState()
on('turn.step', async function* ($, e, next) {
  if (e.agentId === undefined) {
    state.observeStep(e)
    try { $.ui.invalidate('ui.render') } catch { /* repaint unavailable */ }
  }
  return yield* next(e)
})
```

- [x] `AbovePrompt`는 먼저 downstream tree를 얻는다. survey이면 그대로 반환한다. 그 외에는 `$.session.model()`로 표시 데이터를 만들고 `$.ui.resolve(e)`의 Box/Text로 기존 tree 뒤에 띠를 추가한다. full은 round border, compact는 설명과 badge 생략, inline은 border 없음이다. Text의 `wrap="truncate-end"`로 줄바꿈을 방지한다.
- [x] 각각 추가 테스트를 먼저 실패시킨다: survey tree 보존, 0폭/0행 비표시, subagent step 이후 effort 불변, 모델 변경 후 unknown, effort 누락 후 unknown, session.end/turn.start reset, 설정 거부 시 상태 유지, session.model 거부 시 unknown, invalidate 실패 시 next 한 번, downstream throw의 한 번 전파.
- [x] stream fixture는 `thinking`/`text`/`stop`과 최종 `TurnStepResult`를 반환한다. 소비 측에서 단계별 `.next()`를 호출하고 마지막 `done: true`의 value도 비교한다. `for await`만으로는 최종 반환값을 검증할 수 없다.
- [x] 반복 render와 terminal/desktop surface의 반환 tree를 검증한다. 색·border·주요 문자열이 포함되고 downstream sibling이 남는지 확인한다.
- [x] 대상 엔진의 타입을 생성하고 `tsc`/validate 및 코어 suite를 실행한다. 실패를 해결한 뒤 커밋한다:

```sh
./node_modules/.bin/tsc -p model-effort-band
/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin validate model-effort-band
npm test
git add .gitignore model-effort-band
git commit -m "feat(model-effort-band): render live model and effort above prompt"
```

## Task 3: 설치와 검증 경로

**Files:** `.claude-plugin/marketplace.json`, `scripts/test-core.mjs`, `scripts/test-adapters.mjs`, `package.json`, `README.md`, `model-effort-band/README.md`, `model-effort-band/README_KR.md`

- [x] core runner의 모드 목록에 추가하기 전 새 suite가 집계되지 않는 것을 확인한다. 추가 후 실제 `npm test` 출력에 새 suite가 실행되는지 확인한다. 소스 문자열 일치 테스트는 만들지 않는다.
- [x] 두 runner의 모드 목록과 typecheck 명령에 `model-effort-band`를 추가하고 marketplace에 항목을 추가한다:

```json
{
  "name": "model-effort-band",
  "source": "./model-effort-band",
  "description": "Shows the selected model and observed main-thread effort in a colored band above the prompt"
}
```

- [x] 영어/한국어 README에 설치, 로컬 로드, 모델별 preview, effort 관측 의미, 최초 unknown, 좁은 폭, survey, surface 제한, alias/resolved ID 불일치, 2.1.292 검증 바이너리를 기록한다.
- [x] 설치 예시 (기존 README와 git remote로 저장소명 확인 완료):

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install model-effort-band@my-claude-code-mods
```

- [x] 로컬 로드는 `claude --plugin-dir ./model-effort-band`이다. 기본 바이너리가 2.1.280인 환경에서는 검증 바이너리를 명시한다.
- [x] 전체 코어 suite, 기존·신규 엔진 suite, 전체 typecheck, plugin validate를 실행한다:

```sh
npm test
CLAUDE_BIN=/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude npm run test:adapters
npm run typecheck
/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin validate model-effort-band
git diff --check
```

- [x] 대화형 UI 사용이 가능하면 모델 세 종류·effort 각 수준·폭 변경·survey·다른 모드와의 병용을 실제 화면으로 확인한다. Desktop에 접속할 수 없다면 미검증으로 기록한다.
- [x] 스펙의 각 항목을 구현·테스트·알려진 제약과 대조한다. 누락을 수정하며 동작 변경은 RED→GREEN으로 증명한다.
- [x] 통합 단위를 커밋하고, 커밋 이력·테스트 결과·실제 화면 검증 여부를 사용자에게 보고한다. push는 하지 않는다.

```sh
git add .claude-plugin/marketplace.json scripts/test-core.mjs scripts/test-adapters.mjs package.json README.md model-effort-band/README.md model-effort-band/README_KR.md
git commit -m "docs(model-effort-band): register mod and document installation"
```
