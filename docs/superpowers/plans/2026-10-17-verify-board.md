# verify-board Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the requested sequential order.

**Goal:** Track verification results against repository content; changes during or after a run invalidate passing results.

**Architecture:** A standalone top-level `hooks/register.ts` adapter calls a tested `hooks/core/feature.ts` command/observation model. A vendored runtime provides safe text, Git reads and session-scoped durable transactions; its canonical source lives under `scripts/workflow/`.

**Tech Stack:** TypeScript, Claude Code function hooks, Node test runner, actual engine adapter tests.

**Spec:** `docs/superpowers/specs/2026-10-17-verify-board-design.md`

## Global Constraints
- Node >=22.19.0; no new dependencies or sibling-mod imports.
- Observer failures must not fail or rerun the underlying tool.
- Mask obvious secrets and terminal controls before storage/display.
- Bound retained items and filesystem scans; mark unknown/incomplete results.

## Review Focus
Verification revision comparison; unknown and denied results; concurrent edits; external edits; bounded snapshots.

### Task 1: verify-board usable mod

**Files:** Create `verify-board/hooks/core/feature.ts`, `verify-board/hooks/register.ts`, `verify-board/tests/feature.test.ts`, `verify-board/tests/adapter.test.ts`, manifests, tsconfig and English/Korean READMEs. Update marketplace and test/typecheck inventories.

**Interfaces:** `Feature.command(args: string, io: Port): Promise<string>`; `Feature.observe(observation: Observation, io: Port): Promise<void>`; JSON-safe `Feature.data`. Commands use `/verify`. Port provides cwd, file reads, argv-based processes and environment presence.

- [x] Write real behavior tests covering the primary workflow and the Review Focus cases; engine tests cover command registration, tool forwarding, isolation and persistence failure.
- [x] Run focused tests and observe failure caused by missing feature behavior (RED).
- [x] Implement analysis, bounded state, commands, adapter and standalone packaging.
- [x] Run focused tests, actual engine suite and TypeScript checks (GREEN); refactor only while green.
- [x] Run `npm test`, validate manifest and commit `feat: add verify-board mod`. Record results in `docs/verification/2026-10-17-workflow-mods.md`.
