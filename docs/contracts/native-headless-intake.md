# Native headless intake: Agent and TUI

`goodvibes-agent run`, `goodvibes run`, their `exec`/`e` aliases, and `-p`/`--prompt` use the published native conversation capture/admission contract. They require an existing authenticated paired daemon principal. They do not fall back to legacy hosted turns, direct ordinary routing, or local model execution when admission is unavailable.

## Original source and ownership

The original argument text is retained without trimming, reference expansion, or image expansion. Multiple positional arguments are joined by one space; shell quoting determines each argument's bytes. `--` ends CLI option authority. For example, `run -- --intake-cancel` captures that literal text instead of cancelling anything. Flag-shaped `--prompt` values use the existing inline grammar, such as `--prompt=--intake-cancel`.

Before capture, the client durably saves the exact request ID, input ID, original text and unsupported-source markers. The journal is bound to the selected endpoint, project, canonical workspace and server-verified principal. A host, credential, principal or journal change cannot inherit an earlier input's authority. Existing durable storage, symlink, byte-bound and atomic-publication checks remain in force.

Only a fresh durable dispatch claim plus the host-bound native turn permit may enter the ordinary executor. Native work uses the exact admitted work ID, attempt ID and expected revisions, with an execution intent saved before start. Model execution cannot precede successful admission. Permits and authentication tokens are never included in the final output.

## Recovery controls

Supply exactly one control and no replacement prompt:

- `run --intake-status`: reads the retained input and execution status. It does not capture, admit, claim, start or resume anything.
- `run --intake-retry`: looks up the original input first. If necessary it replays the same durable capture or requests admission. A recorded turn with no dispatch claim can be explicitly recovered once; an already claimed turn is never automatically replayed. Processing requires explicit resume. Work reconciliation uses status before any first start and never automatically resumes execution.
- `run --intake-resume`: explicitly resumes retained intake processing or recovers an unclaimed terminal turn. This is intake recovery; an already existing work execution still needs the native work controls for execution resume.
- `run --intake-cancel`: cancels the retained nonterminal intake, or the exact saved work attempt when an execution intent exists. Blocked/refused inputs and already admitted ordinary turns are not rewritten.

A lost acknowledgement remains unknown until inspected. Read-only status does not turn an observed decision into permission to dispatch. A dispatch claim that survived a crash is kept even when the caller cannot establish whether its turn ran.

## Signals and output

SIGINT/SIGTERM exit with 130. Automatic cancellation is restricted to input durably created by the interrupted submit invocation. Merely reading an older retained input during submit, status or retry cannot cancel it. When the fresh local turn is running, its invocation-owned orchestrator is aborted. Server cancellation is bounded; inspect status if the response cannot establish the outcome.

Text writes a human-readable result. JSON writes one final object. Stream JSON writes zero or more `STREAM_DELTA` objects followed by `NATIVE_INTAKE_RESULT`. Runtime notices use stderr. Native result/receipt and exact source identity are included, but process-local turn capabilities are omitted.

Exit codes: 0 means a completed ordinary turn or recorded native status/work response, 1 means unavailable/refused/blocked or turn failure, 2 means invalid invocation/source, 3 means unknown or recovery-required outcome, and 130 means interruption or cancelled input. A work response is acknowledgement/status, not proof that work completed or passed verification.

## Verification

`products/agent/src/test/cli/native-headless-entrypoint.test.ts` drives both actual source entrypoints against a real paired daemon and native persistence. Only external model/Jev replies are deterministic fixtures. It verifies exact capture, literal option boundaries, lost acknowledgements, restart/status/retry, cancellation ownership, and shared/revoked credential refusal. The test network guard remains enabled.

For identical compiled-artifact proof, set `GOODVIBES_HEADLESS_AGENT_BINARY` and `GOODVIBES_HEADLESS_TUI_BINARY` to the built executable paths and `GOODVIBES_HEADLESS_REQUIRE_BINARIES=1`. The harness refuses missing artifacts rather than silently substituting source. Focused ownership/option tests cover both products; this document alone does not assert that any particular test run passed.
