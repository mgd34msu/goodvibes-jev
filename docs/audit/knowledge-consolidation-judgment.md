# Knowledge consolidation reading (THE-19)

## Implemented boundary

The existing bounded, 30-day usage scan still selects subjects for consideration. Reads follow observed recency and stop at the caller's limit (24 by default, a hard ceiling of 64 requests per run); this is a request budget, not a worth score. Complete stored summaries reach the reading and candidate, rather than a potentially misleading 220-character display prefix. Oversize or protected inputs hold before transmission through the shared boundary. The registered `engine.knowledge.consolidation` battery now reads whether each subject's title/summary is worth keeping as durable project memory and which content class applies: fact, architecture, ownership or runbook. Usage counts, distinct sessions/kinds and graph relation counts are evidence, not a hand-weighted score. Display scores are the returned worth probability. ISO timestamps avoid an epoch counter accidentally resembling card material at the shared protected-input boundary.

Source-refresh and stale-memory-review candidate types remain structural status/cadence choices. The old usage weight ladder and the 45/72 candidate/promotion thresholds are removed. This is the bounded consolidation slice, not the remaining knowledge search, aliases, entity alignment or extraction work.

## Staging and durable writes

- A yes in the confirm band may stage an explicit open review candidate. Staging is not durable-memory promotion
- Automatic promotion requires both worth and memory-class readings at act, an open memory-promotion candidate and an unchanged exact subject snapshot
- Uncertain/no readings do not supersede earlier operator decisions or old open review candidates. Missing/failed ports fail visibly; the automatic write phase does not begin if any subject reading fails
- Explicit operator acceptance may resolve a review candidate and choose a class/scope. Source changes after its reading require refreshing before acceptance
- A terminal operator decision is preserved in full across refresh, including a decision made while a reading was in flight
- Same-store refresh/decision operations serialize per subject and candidate type. Concurrent accepts and retries cannot append duplicate memories in that process
- Durable memories retain candidate, subject and available session provenance. If memory persistence succeeds before candidate persistence fails, replay recovers the existing memory by the candidate provenance link

The two stores are not one transactional database. Provenance-based replay recovery and process-local serialization do not claim distributed multi-writer atomicity. No existing user state is migrated by this change.

## Evidence and remaining gates

Synthetic tests use temporary real SQLite knowledge/memory stores, disabled vector indexing and explicit fake judgment readings. They cover contrary-to-old-score decisions, review/act bands, unavailable/failed ports, known protected content before transmission, stale snapshots, an operator decision during reading, idempotency, provenance and partial-persistence recovery. The six focused consolidation/review/refresh/memory/isolation/retention suites pass 28 tests and 102 assertions.

The battery registry provides seven named fixtures covering both worth answers and all four memory classes. Fake-port execution tests are not semantic accuracy evidence. Live calibration is blocked here because no System One endpoint/key is configured. Once securely configured, the registry can be calibrated through the existing judgment package runner:

`bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/knowledge/judgment-registry.ts`

Final aggregate lint and whole-project/product proofs remain separate gates; no fake live result or waived hook is part of this implementation.
