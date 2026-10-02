# Legacy planning guard compatibility after PR76

This bounded change reuses the planning-action portion of PR57 on main
`8a96edeb9a2e214b9a565d1b44b585148398c8c9`. PR76 already supplies the hardened
KnowledgeStore/SQLite persistence boundary. None of those storage files is
replaced here.

`getState` returns state, source and optional `revision:{sourceId,generation}`
from the same detached persisted-row snapshot. A missing source has no revision.
The existing shared GET/POST state output schema describes the optional revision;
POST upsert still omits it. Existing
trusted-admin state-upsert behavior is unchanged; there is no new HTTP mutation
route or permission grant.

`applyStateAction` binds a named approve/answer action to either a selected
revision or one current-mode snapshot. Input and expectation are captured before
the first await. The final write uses `upsertSourceIfCurrent`; a changed source
returns `state-changed`, and matching source with pending local writes returns
`pending-local-changes`. Neither hold writes source, tasks or work-plan bytes.
A source generation is a content precondition, never execution authority.

The existing `answerQuestion` entry point now delegates to this guarded
current-mode answer path. Its existing result shape and validation failures stay
available. Its failure-reason union adds `state-changed` and
`pending-local-changes`; callers must display/reconcile these rather than treating
a resolved promise as success. Returned state and evaluation use the same action
result. Input mutation during initialization cannot retarget the answer or its
reported project identity. Storage exceptions continue to reject the promise.

After a source write is accepted, derived task/work-plan synchronization remains
multi-step. A later synchronization failure can follow a committed answer or
approval. This is not an atomic outbox or a retry receipt protocol; callers must
re-read before deciding what happened. Native ledger receipt and authority
semantics are unchanged.

## Caller acceptance remains separate

The current tree has daemon and webui products, not the historical TUI/Agent
product sources. The known TUI producer paths are
`src/input/commands/planning-runtime.ts` and
`src/panels/modals/planning-modal.ts`. Their selected approve/answer actions must
carry the displayed revision into the command and actual SDK call; an absent
selected revision must not become current-mode. Manual commands can explicitly
use current-mode. Copied-source evidence on `a17c7cc6` remains historical evidence,
not current product build/startup acceptance.

PR57 can be closed as superseded only with explicit accounting for this bounded
compatibility replacement and the actual caller migration or retirement. The
native ledger alone does not replace those callers. The owner-reply declaration
annotation is unrelated and is not included unless current API gates require it.

## Verification of this candidate

- Nine focused engine suites: 70 tests, 274 assertions, no failures. Includes
  selected/current action races, legacy answer races/input capture/batch holds,
  real independent handles and process writers, strict locks, existing planning
  answer/service/routes and plan integration.
- Forced repository solution plus engine test/scripts, public-consumer types and
  all present product typechecks: no diagnostics. TUI and Agent workspaces are
  absent, so these results do not claim their acceptance.
- Regenerated contracts, OpenAPI, foundation client types, fixtures, web facade,
  operator docs and SDK/subpath reports from this source. Standard `api:check`,
  `contracts:check`, OpenAPI, facade and foundation-I/O checks pass: 165 SDK
  subpaths / 10,106 exports, 3 terminal subpaths / 199 exports, 513 typed methods.
  API Extractor retains the existing compiler-version, sql-js duplicate and
  Gaxios declaration warnings; extraction exits successfully.
- No full engine test-suite, product build or compiled startup run is claimed.
