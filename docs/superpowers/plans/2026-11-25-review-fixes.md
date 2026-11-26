# Review findings fixes implementation plan

> Execute inline with superpowers:executing-plans and test-driven-development. User authorized all five fixes. No publishing or merging requested.

**Goal:** Fix five reproduced correctness/safety issues without changing normal commands or adding dependencies.
**Spec:** Review findings and reproductions in this conversation; /tmp/mods-code-review contains the original probes.

- [x] Preserve process truncation flags in time-machine Runner, reject incomplete Git evidence; unit and real-Git restore regression must retain the ignored file and never reach read-tree on incomplete listings.
- [x] Capture Time Machine stream context/turn and Context Inspector stream/tool/compaction owner; old completion after clear must never enter the new session export. Keep current-session streams and results unchanged.
- [x] Canonical scripts/workflow/runtime.ts converts porcelain paths from Git root to cwd using --show-prefix; preserve outside paths as ../ paths. Review Queue lists outside entries without reading/marking them. Test real nested repos, rename sides and outside warnings; sync standalone runtime copies.
- [x] Dependency Lens uses cwd-relative historical path resolution. Test clean nested packages, changed nested dependencies and deleted/absent manifests.
- [x] Pin Memo uses bounded v2 hashed keys with <=256-character legacy fallback and safe mutation migration. Test long POSIX/Windows identities, legacy 256/257 boundary, reload and corrupt-state behavior.
- [x] Run full core, engines, types, privacy and workflow-sync checks; repeat original repros; document exact results and remaining limitations. Bump changed mod patch versions.

Each implementation starts with a failing regression. Keep long performance-sensitive suites sequential. Independent reviewers were unavailable due account limits in the review turn; do not claim independent review unless one actually runs.

Verification: [2026-11-26 review fixes](../../verification/2026-11-26-review-fixes.md). All five items implemented. Independent follow-up finding addressed and re-reviewed. The user requested continuation; changes are finalized as a local commit on fix/review-findings. No merge or remote push is included.
