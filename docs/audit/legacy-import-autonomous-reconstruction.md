# Autonomous import reconstruction checkpoint

This is a new reconstruction after the October 3 executor replacement, not a claim that the lost intermediate source was recovered byte for byte. It starts from public main `874ebe17` and locally composes published import core `6235459f`. The separately held PR94 conformance/publication repair is not included.

## Restored and tested

- One canonical workspace/project journal path for Agent and TUI, with realpath alias convergence and fail-closed detection of an earlier Agent journal.
- Complete immutable import command and request identity, private SQLite files, immediate cross-process transactions, EXTRA synchronization and containing-directory/ancestor fsync ordering. Tests cover process interruption, not hardware power-loss guarantees.
- Pending, unknown, accepted, rejected and cancelled recovery states. Unknown requests retain exact command identity; cancellation after dispatch cannot imply rollback. A late accepted receipt wins over later rejection. Every result variant is structurally validated.
- Actual shared `JevDecision` provenance stored alongside the exact command and authenticated selection. Structural receipt parsing does not grant execution permission. Old journals retain empty provenance rather than gaining invented decisions.
- Host preparation uses existing admin, `read:work-ledger` and `read:knowledge` authority. Both product command entry points allow preview/status without a keyboard gesture or human-confirmation claims. Complete pagination is mandatory; malformed cursors, duplicate source IDs and the 5000-source discovery cap fail closed. Revocation is checked again before displaying protected read results.
- Product clients pin the existing endpoint, credential and authenticated principal. Credentials are neither minted nor persisted in the journal. Source history remains historical and unverified.

Focused tests are `legacy-import-recovery-reconstruction.test.ts`, `legacy-import-read-reconstruction.test.ts`, and `work-ledger-import-transport.test.ts`. They exercise synthetic data and actual product/host route code, with no live user import.

## Remaining production dependency

The products expose only preview/status in this checkpoint. Mutation submission, autonomous reconsideration and exact dispatched recovery are not yet composed to a semantic evaluator. The inherited core route is the published PR94 behavior; it still needs the host-owned autonomous admission integration before this workflow can be called complete.

Required shared seams are the real recorded Jev evaluator, one availability retry owner, registered versioned continuation/condition execution, and live authority/scope generation retrieval. The host must independently capture command/source/authority/scope revisions, validate actual recorded judgment lineage, persist exact decision provenance, and recheck revocation/currentness at atomic dispatch. A parsed `act` receipt, a model-supplied flag, or equal principal/scope strings after revocation and restoration cannot substitute for these checks.

Native ledger types/service and daemon composition are coordinated with the separate native execution reconstruction. No competing judgment schema, retry loop, human-confirmation fallback or fabricated act evaluator is supplied here. Full engine/product type checks, API baselines, independent review and fresh compiled acceptance remain outstanding for this reconstruction.
