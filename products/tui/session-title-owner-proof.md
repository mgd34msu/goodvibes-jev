# Shared session title generation

This is the bounded THE-62 C5 adoption for the original
`src/core/session-auto-titler.ts` HOIST row. It does not close the other TUI
migration responsibilities or claim live-provider/compiled-application proof.

## Ownership and compatibility

- `@goodvibes-jev/engine/sdk/platform/sessions` exports
  `createSessionTitleGenerator`, `SessionTitleGenerator`, `SessionTitleModel`
  and `sanitizeSessionTitle`. No new package subpath is required.
- The engine owns extraction of the first nonempty user text (including text
  parts), the unchanged title prompt, the 2000-character input bound, the
  24-token request, deterministic formatting and the 60-character output bound.
  The supplied model is the existing configured tool/helper model. This is text
  generation, not a Jev semantic reading or authorization decision.
- The generator claims its single attempt before awaiting the model. Missing
  user text consumes no attempt. Input snapshots are acquired lazily, so a
  consumed attempt never clones the history again on later turns. Rejection and empty responses return no title,
  and still consume the attempt. No retries, new model selection or extra
  spending are introduced.
- TUI settings remain product-owned and off by default. The actual
  `wireSessionAmbience` caller delegates via the thin existing auto-titler;
  it retains TURN_COMPLETED subscription, title application, notification and
  repaint. Live configuration remains readable before each attempt. As before,
  disabling the setting prevents new attempts, but does not cancel the result
  of an already-started call that still belongs to the same live conversation.
- The TUI rechecks user-title ownership immediately before applying a result.
  Session ID, conversation replacement generation and terminal lifetime must
  still match. Unsubscribe closes delivery before removing the listener.
- The product conversation replacement generation advances only at resetAll
  and fromJSON, including /clear, /reset, import and same-ID resume. Normal
  message append does not invalidate the title. SDK's private message-cache
  revision advances for ordinary message edits and cannot express this lifetime.
- Reset, reload, a late result or disposal never creates another generator or
  resets its single-attempt budget. The model interface has no cancellation
  signal; in-flight work may finish, but cannot write a title or repaint after
  losing ownership. No shutdown wait is introduced.

## Source evidence

`packages/engine/test/sessions/session-title.test.ts` covers the exact prompt
and limits, text extraction, pre-attempt missing input, overlap and failed/empty
single-attempt behavior, and formatting.

`src/test/runtime/session-ambience-title.test.ts` drives the actual ambience
composition with a real TUI ConversationManager and controlled tool model. It
covers default-off and live opt-in, one call/notice/repaint, user-title race,
session switch, same-ID reset/fromJSON, the real same-ID resumeSessionCore with
stored session data, disposal, terminal restore and normal append. Five
late-delivery cases fail against the old implementation and pass with this
adoption. Original title tests remain in `src/test/core/session-auto-titler.test.ts`.

Affected source/test types, public API snapshot checks, independent review and
exact-head CI are separately qualified; source tests alone do not certify them.
