# handoff-pack Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the requested sequential order.

**Goal:** Preview a local Markdown handoff with explicit goal/todos, observed failures, changed paths and verification evidence.

**Architecture:** A standalone `hooks/register.ts` adapter wraps a tested `hooks/core/feature.ts` command/observation model. A vendored runtime provides safe text, Git reads and session-scoped durable transactions; its canonical source lives under `scripts/workflow/`.

**Tech Stack:** TypeScript, Claude Code function hooks, Node test runner, actual engine adapter tests.

**Spec:** `docs/superpowers/specs/2026-10-17-handoff-pack-design.md`

## Global Constraints
- Node >=22.19.0; no new dependencies or sibling-mod imports.
- Observer failures must not fail or rerun the underlying tool.
- Mask obvious secrets and terminal controls before storage/display.
- Bound retained items and filesystem scans; mark unknown/incomplete results.

## Review Focus
Empty sessions; denied tools; secret masking; no automatic exports; bounded history.

### Task 1: handoff-pack usable mod

**Files:** Create `handoff-pack/hooks/core/feature.ts`, `handoff-pack/hooks/register.ts`, `handoff-pack/tests/feature.test.ts`, `handoff-pack/tests/adapter.test.ts`, manifests, tsconfig and English/Korean READMEs. Update marketplace and test/typecheck inventories.

**Interfaces:** `Feature.command(args: string, io: Port): Promise<string>`; `Feature.observe(observation: Observation, io: Port): Promise<void>`; JSON-safe `Feature.data`. Commands use `/handoff`. Port provides cwd, file reads, argv-based processes and environment presence.

- [ ] Write real behavior tests covering the primary workflow and the Review Focus cases; engine tests cover command registration, tool forwarding, isolation and persistence failure.
- [ ] Run focused tests and observe failure caused by missing feature behavior (RED).
- [ ] Implement analysis, bounded state, commands, adapter and standalone packaging.
- [ ] Run focused tests, actual engine suite and TypeScript checks (GREEN); refactor only while green.
- [ ] Run `npm test`, validate manifest and commit `feat: add handoff-pack mod`. Record results in `docs/verification/2026-10-17-workflow-mods.md`.
