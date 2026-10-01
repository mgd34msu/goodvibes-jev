# Daemon status, session and config command adapters

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

Four product modules and their four original test suites are ported:
`local-daemon-state`, `status-command`, `sessions-command`, and `config-command`.
All eight source mappings are explicit in the partial migration manifest.
The executable dispatcher and service lifecycle commands remain outstanding;
these functions do not establish complete daemon CLI parity.

Status and update reporting preserve HTTP endpoint/envelope selection, the
shared remote-target convention, operator-token handling, partial-failure
reporting, local-only receipt/lifecycle reads and the honest absence of an
early update-check verb. Hosted session list/kill retains the named ws-only
method contract, argument checks, request bodies and daemon error rendering.
The transport helpers are the public terminal-shell exports already hoisted
from the daemon. This product does not maintain a second implementation.

Lifecycle marker bounds, field types, closed status values, argument grammar,
schema-key equality and duration formatting retain their inventory decisions.
Config sensitivity remains the canonical terminal-shell decision: declared
schema keys use their schema declaration and unknown nested paths use the
registered credential-key reader. The command helpers now return promises,
and every current caller awaits them. Future executable wiring must do so too.

## Nested config output correction

The pinned plain-text renderer checked only an object's parent setting before
serializing the entire value. A deterministic regression using the declared
`pricing.modelPrices` object setting reproduced an unredacted nested dummy
value. Object rendering now calls the same recursive `redactConfig` used for
JSON output. Scalar rendering, unset/empty/false/zero handling and recognized
secret references retain their original behavior. No lexical sensitivity
fallback or duplicate classifier was added.

Tests install the public judgment test port with explicit fixture-path answers.
Only key paths reach that reader; value contents never do. Coverage includes
plain-text/JSON list, get, set and unset receipts and rejection when a nested
path cannot be read. An unavailable reader cannot produce an unclassified
object receipt. The daemon declares judgment as a development dependency for
these fixtures; production dependencies and engine exports are unchanged.

## Validation scope

The original 65 tests retain their assertions, with config calls awaited.
Three additional config regressions cover the nested-output correction.
A separate loopback test runs actual `createRuntimeServices` and
`DaemonServer`, exercising status HTTP, hosted-session WebSocket listing,
update reporting, invalid-token refusal and awaited shutdown. Metadata is
explicitly fixture-backed and the inbox factory is supplied, so this is the
configured graph rather than a built-in provider or live inference proof.

No service is installed or restarted, no real session is killed, and no live
account, credential store, mail, payment, provider or remote host is used.
