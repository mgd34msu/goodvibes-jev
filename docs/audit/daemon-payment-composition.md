# Daemon payment composition and reply ownership

Source: `goodvibes-daemon` at `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, `src/runtime/payments-composition.ts`.

The product port keeps the surface-scoped card metadata, purchase, budget, owner approval and in-flight checkout files. Card material uses the existing daemon-tier secret port. The browser checkout seam remains a getter; no substitute browser is composed. The retired provider-prompt merchant adapter is replaced by the engine's registered `createJevMerchantJudge` reading.

## Shared identity and ownership

`createPaymentsServices` constructs one actual `PaymentReplyInbox`, supplies it to `channelBackedPaymentNotifier`, and returns it as `paymentReplies`. The root must pass that exact object to `DaemonConfig.paymentReplies`. The facade passes the borrowed object through its collaborators into `DaemonSurfaceActionHelper`, whose established ingress policy authenticates owner/channel before offering replies. The product root is the shutdown owner. Listener restart must not close this borrowed inbox.

Stop ingress and await `PaymentsServices.close()` before releasing the graph or registering replacement handlers on the catalog. The compatibility `unregister()` initiates that same close. Close stops handler and reply admissions, rejects open waits, and drains the registration promise and accepted reply readings. It does not claim to drain browser/gateway work already admitted: the full root must await those operations separately.

`null` from a payment wait means genuine deadline silence, which may permit a veto purchase. Shutdown therefore rejects with `PaymentReplyInboxClosedError`; it must never manufacture silence, acknowledgment or approval. Rejection is safely observed for legacy void callers without changing the promise seen by awaiting callers. Accepted readings are registered before invoking the port, so a reentrant close cannot miss them. Failed readings remain observable to their callers and late answers cannot reopen a closed window.

## Evidence and limits

- Engine tests cover active approval/veto rejection, real elapsed silence, accepted and failed reading drain, late/reentrant shutdown, new admission refusal and ignored legacy waits
- The actual `runCheckout` veto path receives a delivered fixture notice and aborts on close before card read, page fill or submit; its unresolved journal record remains available to the existing recovery rules
- Product tests invoke the real catalog and stores, preserve live owner limits/leadership, close during registration, safely reuse a catalog after awaited close, and run an actual checkout through the composed notifier and returned inbox to an owner veto
- Tests use dummy card material in a memory-only secret port, metadata in owned temporary directories, fake judgment readings and a recording channel/browser. No real merchant, account, credential store or payment is contacted
- Full `createRuntimeServices` plus `DaemonServer` startup/shutdown, root field wiring, original whole-product tests, live Jev proof, source-delta reconciliation and combined branch integration remain pending. This slice is not daemon boot completion

The facade's existing work-proposal store construction was extracted unchanged to an internal helper to preserve the 800-line composition cap; its policy and initialization warning remain the same.
