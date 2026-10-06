# Runtime notice occurrence provenance

Runtime occurrence identity is independent of agent ids, contract ids, traces,
timestamps, prose, and token usage. A later wake or a restored nonterminal
contract can produce an identical outcome under the same entity id.

## Producer and delivery contract

- Agent completion/failure emitters mint an `occurrenceId` once per new outcome.
- `emitContractEvent` mints a new id before fan-out. Its returned event is the
  occurrence delivered to synchronous runner listeners and the runtime bus.
  Lower-level typed contract emitters retain an explicitly supplied source id;
  absent one, a direct new emission mints its own. Replaying an existing bus
  envelope retains its payload, including the id; it does not re-emit a new
  source outcome.
- The host runtime bridge and Agent delegated-task bridge pass provenance
  beside the rendered line. Routers must forward it separately from prose.
- Conversation system messages store `runtimeEvent: { type, occurrenceId }`.
  Snapshot cloning and the existing JSONL session writer/loader retain it;
  restoring a conversation supplies it to the same notice sink.
- `runtimeEventKey` accepts only a supported event type, a matching declared
  type and a nonblank occurrence id. `runtimeEventOfNotice` additionally
  requires a declared notice format whose type matches that provenance.
  No key is inferred from an entity, a timestamp, a trace or the notice text.

TUI and Agent notification feeds fold an identified arrival into its existing
entry, preserving notice-authoritative diagnostic detail and strongest severity.
Collapsed groups retain detail for each occurrence, including late enrichment;
a shorter replay cannot erase an earlier diagnostic suffix. Restored delivery
latches that occurrence silent in either bus/notice arrival order without
marking unrelated live group members seen or silencing their notices. Replayed
arrivals do not increase occurrence counts. Restored entries stay seen and
silent even when a subsequent live bus catch-up delivers the same occurrence.
Configured routing targets remain unchanged: Agent activity-only routing does
not create a conversation notice. Keys are forgotten when their notification
history entry is dismissed, evicted or cleared. A collapsed burst/batch group
rotates after 100 distinct occurrences; the 2,000-row history therefore retains
at most 200,000 occurrence keys. All keys remain valid while their group is
retained, including older rotated groups. Once a row leaves that bounded
history, a later replay can appear again. A producer occurrence also owns the
standalone row key, so reused delivery ids cannot overwrite distinct outcomes.
Older and malformed identity-free notices remain independent entries rather
than losing real outcomes. A host that drops the optional provenance remains
backward-compatible but cannot claim cross-path deduplication.

## Evidence

- Engine real-agent `wakeWithSteer` tests retain two distinct completed/failed
  outcomes for one agent and match each operator line to its source event.
- Engine real contract import/resume tests distinguish repeated failed,
  cancelled, passed and committed outcomes with identical text.
- TUI tests drive real typed emitters, the bus notification bridge, host router,
  conversation, JSONL persistence and replay for both agent terminal outcomes
  and all contract terminal/commit statuses.
- Agent tests exercise its real delegated-task bridge, system router, history,
  JSONL restore and bus replay, including deferred failure-detail enrichment
  and turn-budget outcomes.
