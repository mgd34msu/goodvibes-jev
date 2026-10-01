# Live notification privacy reader prerequisite

This runtime-neutral prerequisite adapts the `readNotificationsMetadataOnly`
seam from SDK `17eae838461a6529135fe2cad41332d2dc46cb27` onto Jev base
`1330442d5727f7aa63243a075e9807c5ec83eea8`. The public path is
`@goodvibes-jev/engine/sdk/platform/runtime/operations`; it reuses that path's
existing `ConfigGet` type and exports the reader and
`NOTIFICATIONS_METADATA_ONLY_KEY` only.

## Fail-closed contract

Every call reads `behavior.notificationsMetadataOnly` once, live. Only literal
boolean `false` permits content-bearing notification text. Boolean `true`, a
missing key, malformed values (including `"false"` and `0`), and a throwing
getter all require metadata-only output. Read errors are not logged or echoed;
they may contain private persisted values. There is no cached snapshot.

This deliberately differs from upstream's permissive boolean parser and its
absent/invalid-to-false fallback. The setting is not in this build's schema yet.
An older ConfigManager can return undefined for that unavailable key, and its
existing section recovery can reduce a malformed behavior section to defaults.
Neither condition establishes permission to disclose notification contents.
Once a separately reviewed schema installs a validated false default, its
resolved boolean is compatible with this reader.

## Scope and acceptance

The helper is a real decision input for host notification producers, not a
redactor or a privacy feature by itself. Hosts must read it at each delivery and
actually omit turn names, reasons, commands and paths when it returns true.
This slice adds no UI control, producer wiring, schema/default description,
ConfigKey member, setting write, credential classification or gate exception.
No claim is made that all notification channels enforce metadata-only delivery.

Focused tests cover exact key and one read per call, live changes, strict
boolean handling, throwing older readers, private read errors, and real
ConfigManager loads/reloads from synthetic files. They prove that missing keys,
malformed preferences and malformed sections remain restrictive without changing
the input files. The current-schema absence assertion is intentional: schema
adoption must reconcile these tests with the separate persisted-value refusal
policy rather than silently making an invalid restriction permissive.

The preserved combined theme/config work remains blocked on its genuine
credential-key readings. Its exact privacy-key ingestion refusal must still be
integrated with that later schema; this reader does not replace it or weaken
that requirement. The added boolean comparison is structural policy, not a
semantic reading or a keyword heuristic.
