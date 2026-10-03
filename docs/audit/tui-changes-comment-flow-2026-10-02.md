# Changes comment entry and successor coverage

Exact reviewed source fix: `7065b310071b36194094bd634b14665dff2bc37b`, tree
`d60ab17968078b6ed723565cfc640d0a1d5eff63`, over the documentation-only
`1024e8101a535bf8d1d656cc16f91038ba9822c3` checkpoint. Only
`products/tui/src/input/changes-modal.ts` and the new
`products/tui/src/test/input/changes-comment-interaction.test.ts` change.

The forward `ec057c33` UI retires the private DiffReviewPanel class and its
`a` send-all binding, but its public Changes modal and `/review` command still
promise comment attachment and submission. The old inventory test row therefore
could not close solely because its current model-test file matched upstream.

A guarded public-token reproduction found a real upstream-carried bug: the first
Enter's callback cleared `composing`, then `handleTextEntry` returned the old draft
and the caller restored it. A second Enter reattached instead of submitting. The
same helper could repeat commit-message confirmations. The fix returns `null`
after completed/cancelled text entry; its two callers already request that state.
It does not collapse the intended two-step comment flow or change key ownership.

## Verification

- Independent original public-boundary reproduction: five pass, two fail,
  27 assertions, zero network violations
- Expanded final 12-test file replayed against exact pre-fix direct module blobs:
  two pass, ten fail, 34 assertions
- Candidate seven-file guarded modal/diff/golden run: **176 pass, one existing
  tree-sitter skip, zero fail, 427 assertions**, independently reproduced
- Eight additional independent adversarial probes: **eight pass / 61 assertions**
- Full source/test TypeScript: the same **15 held planning diagnostics**, no new
  diagnostic. The author uses a bounded 3 GiB real Node pass. Independent review's
  initial default-heap OOM and completed 8 GiB-limit retry remain recorded rather
  than represented as clean aggregate types

The new tests route actual tokens through SurfaceModalHost: c/text/Enter attaches,
second Enter closes then submits, rapid text cannot navigate while composing,
repeated Enter cannot duplicate, Escape cancels one level, close/reopen preserves
one pending attachment, re-edit replaces a hunk comment, blank drafts do not send,
missing submitInput preserves unsent comments, and preview remains read-only.
The shared commit composer is tested with a cancelled confirmation, so no Git
mutation occurs. Independent probes include actual stacked confirmation ownership.

## Original row covered by two current boundaries

`src/test/panels/diff-review.test.ts` now maps to:

1. `products/tui/src/test/views/diff-review.test.ts`: the five unchanged model tests
   retain parsing, ranges/counts/excerpts and steering-template assertions
2. `products/tui/src/test/input/changes-comment-interaction.test.ts`: attach/send
   structured context, batch unsent comments with duplicate suppression, and
   source provenance at the public modal/submit boundary

Source rendering intentionally follows the current canonical selected-source
label; submitted steering text retains the exact loaded label, with the canonical
fallback when empty. The old private API and old key binding are not restored.
This additional reviewed mapping changes accounting to **1,070 mapped / 548
unresolved**, including 43 verified renamed-source/successor mappings.

Source SHA256: `120a71f2d290fd222b5e769c581277501e0c0b233a95a1391d7cd99b81a04ea4`.
Test SHA256: `acbb4860bb46ff9701a6d2b8cb055b582c46d0e2fb0804458ab94961627dc5e6`.
The source is accepted only for this narrow flow. It is not compiled terminal E2E,
full-suite acceptance, permission to publish, or approval of the host SDK dependency.

## Separate host dependency hold

Later PR69 peer review supersedes the earlier local host-setting acceptance packet.
Readability transitions, restrictive failed project-write recovery, cross-host-key
notifications and typed host access are being repaired in the canonical SDK.
The frozen 7f35938 source/proof remains historical; no consumer adoption of an
unreviewed repair has occurred. A reviewed immutable registered-host boolean handle
is planned for TUI reads/writes/subscription, with existing modal scoped-reset
ownership preserved. Dynamic managed-lock authoring is not added. Corrected SDK
adoption and revalidation are required before host integration can be ready.
