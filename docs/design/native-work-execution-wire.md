# Paired daemon native-work execution

The daemon now registers an identity-only native execution path for an existing
complete `LedgerWork` with an active attempt claimed by that paired principal.
The native graph is acquired lazily after authentication and project validation.
It has its own agent manager and runner; ordinary conversational intake retains
its existing graph. Opening a ledger or requesting status never starts work.

## Client contract

`@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client`
exports `getOperatorWorkLedgerProject(client, options?)` and
`createOperatorNativeWorkExecutionClient(client, projectId)`. They reuse the
selected operator client's existing authenticated transport. No additional token,
permission setting, actor, source, project root or session is accepted.

`workLedger.project` (`GET /api/work-ledger/project`) accepts `{}` and returns the
native ledger owner's `{ projectId }`. It is independent of legacy planning.
Discovery requires current admin and `read:work-ledger`; it does not promise
execution eligibility.

Each of `workLedger.execution.start`, `.status`, `.cancel` and `.resume` has a
`POST /api/work-ledger/execution/<operation>` binding. The strict input is:

```ts
{
  projectId: string;
  workId: string;
  attemptId: string;
  expectedRevision: { work: number; criteria: number; attempt: number };
}
```

The existing attempt is the durable request identity. The server derives the
criteria key, source, original goal and ordered criteria, native action,
authority, scope and session. The client cannot substitute these fields.

All execution operations require a current admin principal authenticated by a
persisted per-pairing token, plus existing `read:work-ledger` and `write:fleet`
scopes. Admin matches the owner-only ledger surface; the dedicated read scope
permits the work identity/progress projection; fleet write matches the executor
being controlled. Even status resolves this owner's execution association and
therefore retains the same paired owner/scope checks. No scope or token is issued
by this path. Shared tokens and user sessions are explicitly unsupported.
Transport-captured scopes are a ceiling and are rechecked against live authority.

The bounded result is now a discriminated intent-or-execution union; see [admission intents](native-work-admission-intents.md). The execution branch contains identity, admitted `expectedRevision`, live
`currentRevision`, `currentAttempt`, `stale`, native association `state`,
`recovery`, the stable `receipt` IDs and typed `progress`. Progress carries only
contract status, session-mode flag, semantic state/stage, retry presence and
unit/criterion counts. It contains no raw source, tool output, authority binding,
execution path, decision context or credential. Execution progress does not
claim ledger verification.

## Revision and lifetime behavior

- Start checks the exact work/criteria/attempt revisions. Exact repeated delivery
  returns the same engine-owned contract and owner IDs.
- Status and cancel find the persisted association by host project and attempt.
  Later work/criteria edits do not strand them. Their result reports the original
  admitted revision and the current ledger revision separately.
- Cancel persists cancellation and waits for background runner and foreground
  session-turn drainage before reporting success.
- Resume is explicit, requires the original admission identity and fresh live
  owner checks, and records a fresh semantic decision for a prepared attempt.
  A lost live owner with a launch claim remains recovery-required; arbitrary
  external effects are never replayed.
  A passed terminal execution instead calls the host's verification/publication
  settlement path, without calling runner start or resume. An existing settlement
  receipt is reconciled through the same explicit action, including after a lost
  acknowledgment. Cancelled execution takes precedence; other terminal outcomes
  cannot restart. The request still uses the original admitted revisions and the
  response shows current ledger revisions separately.
- Status of a missing association/intent returns `NATIVE_EXECUTION_NOT_FOUND` (404). Target-aware cancellation can instead persist a prevention intent after validating the existing active ledger target. Semantic
  refusal `NATIVE_EXECUTION_REFUSED` (422), stale/conflict/recovery failures 409,
  unsupported authority 403, and unavailable/closed state 503.
- Aborting or disposing the client only detaches the local request. It does not
  prove server cancellation. Inspect the same attempt after a lost response.
  The client adds no retries, polling or automatic resume.

## Daemon ownership

The lazy native graph borrows the real daemon configuration, provider registry,
recorded judgment port/log and PermissionManager. The original read filter is
`permissionManager.readAccess(path) === 'allow'`; it is passed to the native
runner and session tools. Workspace incarnation eligibility remains prospective:
legacy registry rows are readable but cannot authorize native execution.

No-delegation execution uses the native contract's foreground session turn,
with a restricted nondelegating tool registry and real contract hooks. It never
spawns an extra unit agent. The existing read-only decomposition planner remains
part of engine planning. Native shutdown fences acquisition and drains owned
turns, agents and processes before borrowed daemon owners are disposed.

Ordinary and native managers share the existing fleet ceiling through a trusted
read-only ownership view. A cancelled or failed execution still occupies its slot
until actual cleanup settles. Final synchronous spawn and wake admission rechecks
that shared view under a reentrancy guard; stale elastic-pool probes cannot admit
both graphs past the cap. Current ACP ownership is counted once. Standalone
managers without this optional composition retain their existing behavior.

## Scope of this checkpoint

This supports existing native work. Creation/claim intake and the ordinary
Agent/TUI conversation path are not converted by these wire methods. Product
controls consume the client in a separate change. There is no general external
effect reconciler, automatic adoption of historical authority, or engine-union
security clearance. Focused fixtures exercise actual paired storage, native
scope, durable runner, recorded admission and the production REST/WS dispatch.

A later attempt also works when the project has not ignored `.goodvibes/`:
Git's raw nested-worktree directory entry is excluded at the known runtime root
before file-path validation. Traversal, repeated separators, lookalike roots and
malformed ordinary inputs keep the existing strict refusal. The regression was
observed failing before this narrow change and passing afterward.
