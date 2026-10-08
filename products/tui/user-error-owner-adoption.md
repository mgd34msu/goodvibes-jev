# Live TUI error reader ownership

This closes the bounded THE-62 C2 caller-adoption gap for the original
`src/core/format-user-error.ts` HOIST row. It does not close the remaining TUI
inventory or change the authority selecting provider failover.

## Owner and lifetime

- Meaning and recovery wording come from public
  `@goodvibes-jev/engine/sdk/platform/routing.readUserFacingError`. The former
  TUI status/word/substring regex classifier is removed, including its
  subscription-session special case. The line reader is also re-exported.
- A product-owned notice queue starts asynchronous readings concurrently and
  delivers in event order. Its 1.5-second deadline bounds narration latency.
  Rejection, missing reader or deadline is explicit unavailable interpretation,
  with the original summarized error; it never fabricates a generic class or
  substitutes a regex. This is not a semantic decision or an approval prompt.
- Cancel/dispose synchronously clear timers and discard delivery closures. The
  public reader has no cancellation parameter, so its underlying request may
  finish, but its settled value cannot reach the closed product lifetime.
- Stream delivery rechecks submission generation, event turn ID, session ID,
  model selection, terminal lifetime and pending failover authority. New user
  submission, cancellation, completion and disposal invalidate prior work.
  Old terminal events cannot revoke a newer turn's notice.
- Existing optimizer selection/visited-provider behavior remains the routing
  owner. The asynchronous wording is not used to authorize/select failover.
  A deadline or unavailable wording therefore does not stop an otherwise
  permitted recovery, and is honestly named in that recovery's notice.
- A pending failover hold is acquired synchronously before reading. The
  one-turn notification owner preserves elapsed time, task and tally through
  both synchronous and asynchronous retry submission. Failed retry releases
  one terminal failure; cancellation/supersession drops the stale hold. The
  existing retry grace deadline independently revokes a retry that never starts.
- The complete failover notice is passed through the existing retry rollback,
  so it is posted after rollback and before the retried prompt. The main
  caller rechecks turn authority after its memory-preparation await; a later
  cancellation/session switch cannot submit old work. The retained turn hold
  also revokes that post-memory authority when the retry grace expires.
- Esc/Ctrl+C invoke the real cancellation action with the pending recovery
  owner, even after the SDK has finalized the failed attempt and isThinking
  is false. Cancellation during either reading or memory preparation cannot
  start another attempt. A new composer submission supersedes old recovery
  before its own asynchronous intake, not just when it reaches dispatch.
- The recovery abort signal remains relayed through native SDK admission,
  which may await permit revalidation while isThinking is false. Actual
  TURN_SUBMITTED transfers ownership without aborting the new active turn.
  External model changes revoke pending admission. The real session fork,
  named save, command resume and browser resume paths cancel pending recovery
  before replacing session identity/history; startup recovery stays unchanged.
- Process rejections use the same bounded owner, keep structural provider
  labeling, and cannot recursively report a reader failure as another unhandled
  rejection. Terminal restore cancels pending delivery before its first terminal
  write. Cascading critical rejections supersede queued individual notices.

## Evidence

`src/test/core/user-error-owner-adoption.test.ts` drives the real stream caller
and public reader, with explicit deterministic judgment responses. It covers
structural status/errno versus deceptive prose, subscription wording, reject and
never-settle behavior, ordered delivery, stale turns, cancellation, completion,
session switch, disposal, rollback and deferred retry authority.

`src/test/core/turn-notice-single-owner.test.ts` composes the real stream and
turn-notification owners. Delayed reading followed by synchronous/asynchronous
retry still produces one end notice with the original user-turn duration. It
also covers cancelled/replaced turns, missing retry context and grace expiry,
including independently reproduced accepted-retry/memory-gap failures and the
real createCancelGeneration path with an already-idle SDK.
`turn-cancellation-recovery.test.ts` and the session/model caller controls
exercise a genuine public native permit held inside SDK revalidation, after
preparation but before TURN_SUBMITTED; cancellation must reject with AbortError
and add no conversation messages.

`src/test/runtime/process-lifecycle-rejection-labeling.test.ts` covers delayed
and rejected reading, terminal restore, session switch, critical supersession,
typed data and interpretation-unavailable behavior. Existing cleanup/restore/
exit tests preserve PR204's listener and best-effort teardown fixes.

Former formatter fixture and router obligations remain in
`src/test/core/format-user-error.test.ts`, now awaiting the public owner with
explicit readings. Existing failover, effort, retry-affordance and stall tests
retain their assertions and await asynchronous delivery.

Source tests are source evidence. Type checks, builds, CI and compiled runtime
qualification must be separately recorded for the exact published commit.
