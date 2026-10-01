# Nullable context-window integration

Original source-review base: Jev main `1330442d`. Integrated parent for build/API verification: `57fe441b2e84921727d11bada563dae101f5b428` (includes reviewed THE-76 conversation integrity, portable fetch types and asynchronous account safety). Sources: goodvibes-sdk `445f75cdde22f82b33cefad197ceb2b1c205b06e` and `92ade7903fb78a0330b3007c05c42d6ef8aa0df0` (reviewed source snapshot through `17eae838461a6529135fe2cad41332d2dc46cb27`).

## Source adaptation and authority

- Custom provider files can omit their context window. Invalid stated numbers still fail validation.
- Numeric `getContextWindowForModel` remains a compatibility budget API. `getKnownContextWindowForModel` is genuinely nullable and is the only ceiling used by automatic compaction/percentage awareness in the adapted consumers.
- Own-provider catalog entries require an exact provider ID or a pre-existing explicit alias. A model ID either matches exactly or is confirmed by the existing `ModelIdentityResolver`; no vendor-prefix stripping, date stems, case folding or provider-name squashing is restored. Pending, rejected and weak readings do not authorize a match. The registry is invalidated after a background reading settles.
- Consensus is intentionally stricter than upstream: figures for one exact catalog model ID across other providers get one vote per provider, majority wins and ties choose smaller. This remains an estimate with `origin.kind = consensus`; it never becomes a known endpoint ceiling. Multiple syntactically different IDs are not combined by a heuristic. Family rows still come only from existing Jev family readings and remain guesses.
- Accepted input is a lower bound, not a maximum. `contextWindowAcceptedFloor` retains it independently of a larger raw display estimate, so a smaller resolved OpenRouter ceiling cannot reappear after restart. Registry reconciliation compares against the effective resolved budget. Once measured, floors increase monotonically even under a still-supported larger ceiling, preventing a later rejection below already-accepted input from becoming known. Unlike upstream's legacy observed-limit reconciliation, a larger success removes a contradicted observed ceiling and persists an accepted floor. A rejection below that floor cannot restore known capacity; a later supported ceiling at least that large can. The override file stays version 2 and old optional sections remain compatible. User-set caps remain separate deliberate constraints, with `user_override` origin.
- Existing OpenRouter model identity and trusted-source policy is retained, with the narrow requirement that a stated OpenRouter ceiling meet an accepted floor. Catalog estimates cannot override that policy or be falsely labeled provider evidence.
- Picker output retains both the budget number and nullable known window plus origin. A numeric fallback that differs from an invalid raw figure is not labeled OpenRouter.

## Necessary consumers

- Agent runner and its split run-context type: unknown/estimate windows cannot trim history or supply percentage awareness. Existing Jev tier selection, audience and cancellation are untouched.
- Context preflight/post-turn: known ceiling thresholds only; provider-issued warnings retain explicit recovery; threshold-driven small-window compaction skips when nothing lies outside its kept messages. A genuine provider warning uses structured recovery even for a short known-small-window history. PR33 awaited system-prompt and abort propagation remains in place.
- Session manager factory and independent manager: unknown uses the pre-existing numeric contract's `0` sentinel. Nonfinite/nonpositive automatic windows are rejected before any threshold arithmetic, state transition, event or mutation. Manual/provider-too-long recovery still runs. Resume repair uses an internal unbounded comparison when capacity is unknown, preserving token-based history; that internal value is neither persisted nor emitted.
- Model-picker enrichment and its data-provider/index dependency contracts carry the nullable observation and detailed origin. The historical numeric field is explicitly documented as potentially estimated.

No edits touch conversation.ts/conversation-utils.ts (THE-76), notification privacy/operations, tier-prompts.ts, routing/model-identity.ts, model-limit-readings.ts or their judgment batteries.

## Verification

Focused tests cover actual registry/provider loading, known/invalid/fallback values, persisted rejection→success→restart→later rejection sequences, OpenRouter floor bounds, explicit caps, consensus estimates, exact/deferred/denied identities, catalog refresh, source labels, actual agent-loop history preservation, nullable picker shape, real independent manager no-op/events behavior, live model changes, explicit recovery, and unbounded resume repair. Existing compaction async-prompt/cancellation, runner steering/retries, audience and identity suites are retained.

Full build/typecheck/API and normal commit hooks are run only after source review under the coordinated compiler slot. Final results and generated API changes are recorded in the delivery report; focused checks alone are not a full gate pass.
