# Profiler permission observation implementation plan

> **For agentic workers:** Execute inline using superpowers:executing-plans; use TDD and commit each independently reviewable improvement.

**Goal:** Restore permission-result observability without participating in permission decisions, and display incomplete timing honestly.

**Architecture:** Read only allowlisted fields from collector `tool_decision` telemetry, correlated by tool-use ID. Store final accept/reject separately from source and classifier. Estimate approval/check wait only for identifiable user/classifier decisions on completed calls with execution evidence (or a confirmed rejection); retain all other waits as unclassified. Use the same timing calculation in reports and OTLP.

**Tech stack:** Existing TypeScript mods API and engine test runner; standard Python only for an isolated real-engine host probe.

**Spec:** The preceding regression analysis and temporary engine probe in this conversation; the user authorized implementing the identified improvements.

## Constraints and review focus

- No `tool.check`, PermissionRequest, or PreToolUse registration; telemetry observer returns `next(e)` unchanged.
- No external telemetry enablement, dependencies, destination changes or raw telemetry-attribute storage.
- Unknown timing is unavailable/partial, never a claimed zero. Final accept/reject is never relabelled allow/ask/deny.
- Preserve total time, execution durations, export chunking and existing tool forwarding.
- Cover absent/malformed/unrelated/duplicate/delayed records, missing execution duration, rejected tools, mixed coverage and subagent IDs.

## Tasks

1. [x] Add failing core/report/export and real-adapter tests for permission observations and missing coverage. Implement bounded metadata parsing and shared timing; register collector observer. Verify focused suites and commit.
2. [x] Add a reproducible isolated host smoke test with telemetry export disabled: automatic Read, explicitly approved Write, rejected Write. Assert ID correlation, reports and exported attributes; validate and commit.
3. [x] Bump profiler runtime/manifest version to 0.1.6, document semantics and limits, record verification. Run full core/adapters/type/privacy/workflow checks, review, and commit.

Verification: [2026-10-23 profiler permissions](../../verification/2026-10-23-profiler-permissions.md). Core 458/458, engine 562/562, types/privacy/workflow and 17 manifest validations passed. Real host probe passed all 3 cases. Independent review found no blockers; the late automatic-batch limitation is documented.
