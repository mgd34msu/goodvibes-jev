# Channel delivery diagnostic boundary

The shared HTTP logger and channel delivery router publish structural diagnostics
without copying known delivery credentials, destination capabilities or private
provider failure text. This is a prerequisite for a standalone daemon send owner;
it does not implement that command or complete THE-18 or THE-123.

## HTTP publication

`instrumentedFetch` retains the actual URL, body, headers, response and rejection.
Its optional `opaque-url` diagnostic mode is selected by the owner of a capability
URL. Telegram, BlueBubbles, Slack response URLs, Discord webhooks/interactions,
Google Chat and generic public webhooks use it. Generic webhook DNS refusal logs
also withhold the destination and borrowed resolver detail; the existing DNS
checks, address pinning, Host header and TLS behavior remain intact.

Default URL diagnostics omit userinfo, fragments and all query names and values.
They additionally redact fixed credential slots in Telegram, Slack and Discord
protocol URLs. These are structural protocol positions, not a classifier for
arbitrary sensitive text. Unknown capability URLs require the owning caller to
select opaque mode. HTTP method diagnostics use a closed set and contain getter
failures. Logger failures cannot turn a completed delivery into another attempt.

## Router publication and receipts

Router failure logs contain only closed surface/strategy/target-kind values and
the existing validated HTTP status projection. They omit raw target addresses,
binding identifiers, error messages and causes. The exact original rejection is
still returned privately to the caller for the existing semantic retry decision;
it is not a safe public error and must not be serialized by a downstream owner.

Known webhook/response URLs and Discord application-plus-interaction-token
fallbacks are no longer returned as message IDs. These successful sends return
the already-supported absent ID. Ordinary provider message IDs remain available.
This does not attest arbitrary provider-supplied IDs as safe for publication.

## Evidence and scope

Owned synthetic tests execute the real strategies and router through a mocked
final fetch boundary, then inspect an actual ActivityLogger file. They verify
unchanged requests and useful status/method diagnostics, raw and encoded provider
credentials, query names/values, response echoes, hostile getters, logger errors,
private rejection identity, ordinary message IDs and both public-webhook pinning
branches. A private-DNS refusal makes zero transport calls and retains its
original private failure while publishing only fixed diagnostics.

No real provider credentials or accounts are used. No global source-classification
or retry policy is replaced. Other publication owners, including
AutomationDeliveryManager's attempt records/events and original error formatting,
require their own bounded handling before public exposure; this change does not
claim application-wide log, receipt or privacy coverage.
