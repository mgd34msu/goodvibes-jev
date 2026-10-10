# Agent background-process lifetime contract

P12 replaces the leading-program name list in Agent's timeout policy with the canonical `agent.tools.long-lived-process` battery. Its definition and calibration fixtures live in `packages/engine/sdk/src/platform/tools/batteries/long-lived-process.ts`, registered in the engine gate judgment registry.

## Decision and unchanged mechanics

The caller's explicit `processClass: "command" | "long_lived"` wins, including the existing fields form. Classification itself needs no judgment port or source-screening owner on this path; registered invocation protection still applies and is never bypassed by an explicit class. Otherwise Jev reads the complete command and the host's declared platform: does it launch a user-facing application or a server intended to keep running after the call? Wrappers and arguments are part of the reading. Browser names in search/output arguments are not launch rules.

Both answers use the high-stakes yes/no band. Only an acting yes becomes `long_lived`; only an acting no becomes `command`. Uncertain, malformed, unavailable and held readings fail closed without guessing a class or spawning a process. The full command is never replaced by a leading-token heuristic.

The existing deterministic mechanics remain:

- Explicit boolean or exact `"true"`/`"false"` kill overrides win. Otherwise only `command` is killable on timeout.
- Timeout defaults to 30 minutes, clamps to 1 second–8 hours, and retains numeric parsing/truncation.
- Grace period remains 5 seconds. Successful exit, running, timed-out, cancelled and failed status use the existing OS/watchdog fields.
- Process age remains timestamp arithmetic. An explicit stop remains independent of timeout classification.

## Protected source and admission lifetime

`terminal`, `process`, and `agent_harness` start routes use registration-owned protected input projection before generic registry readers, logs or repair. Sensitive invocation material is held rather than silently rewriting the execution command. Unrelated process status/capability routes do not acquire this new source requirement.

The classification reader captures and screens the complete command before looking up a battery or hosted port. Literal credential material is rejected locally. Only the owner-issued current projection reaches the battery; the raw command remains local for execution. Local screening must settle, and the reader never substitutes heuristic redaction or classification.

The same protected-source lease stays alive through `ProcessManager.spawn`. Before attempts, log retention, after awaits, and before launch, checks cover cancellation, source authority and owner binding, judgment port/ask/model/recorder and battery binding, workspace/process-manager identity, session identity, and authentic registered execution authority when present. The original tool arguments/options are retained for `assertCurrentToolExecution`; ordinary direct/legacy calls keep that API's existing false-proof behavior.

`SpawnOptions.assertCurrent` is an optional synchronous admission callback. ProcessManager captures its identity before asynchronous credential-environment screening, rejects non-void/async assertions, and checks it again after screening and immediately before `Bun.spawn`, followed by callback-free closed/signal checks. The admission signal and callback do not control an already-running detached process. They cannot convert an ordinary caller cancellation into killing an application that already launched.

## Verification and limits

Offline tests cover the canonical battery fixtures, deliberately contradictory answers, deterministic timeout behavior, raw-source exclusion, unavailable/uncertain/malformed answers, cancellation and binding changes, authenticated permission/registration revocation, and the real ProcessManager asynchronous preparation boundary. The engine tests also pin callback identity against removal/replacement and reject async assertions. Existing harness process and execution facade tests remain regression coverage.

The scripted Jev and local screening services prove control flow and privacy boundaries only. They do not establish live model accuracy or a live privacy certification. Live battery calibration and broad composed-workspace qualification remain separate evidence.
