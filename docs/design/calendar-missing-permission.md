# Calendar missing-permission reading

This completes only the original THE-13 inventory row for
`calendar/calendar-api-shared.ts`. THE-13 remains open for the other original
engine decisions. Tests below are synthetic; no live provider/calibration or
credential changes were performed.

## Decision and evidence

`engine.calendar.missing-permission` is registered in the calendar judgment
registry. A choice over exact source token ids plus `none` and `unresolved`,
backed by a per-candidate fit reading, replaces the old first `scope` / first
`Calendars.*` prose regex. Identifier/URI lexing supplies candidates without
classifying their meaning. The complete response and authentication challenge
remain evidence; ordinary words, already-granted permissions and incidental
mentions are not removed from consideration by code. Instructions in provider
content are untrusted evidence.

The raw body and decoded JSON both remain in evidence. Duplicate JSON keys, including escaped duplicate names and
nested JSON-encoded strings, are refused as ambiguous evidence before parsing
can hide overwritten values. The shared protected-input boundary checks the
complete raw and decoded content before port lookup or transmission. Request
URLs, bearer tokens, event payloads and account labels are never added. Candidate
and context limits produce an explicit `evidence-limit` error, never a clipped
reading or a false settled absence. The lexer is deliberately not a complete
OAuth token grammar: a missing identifier that cannot be represented in full
must be read as `unresolved`, not selected as a partial identifier.

A trustworthy structured shortcut is limited to one fully parsed Bearer
challenge with `error="insufficient_scope"` and exactly one required scope.
[RFC 6750 section 3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)
defines those fields. Multiple required scopes do not identify which one is
missing, so they remain evidence for the registered reading. Duplicate
parameters, multiple challenges and unsupported syntax do not get the shortcut.
Complete-body validation precedes this shortcut: an unreadable or ambiguous body
remains an explicit operational refusal even with a syntactically usable header.
Google error reasons and Graph error codes do not by themselves name an exact
missing permission. Arbitrary fields named `scope` are evidence, not authority.
See the provider contracts:
[Google Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors)
and [Microsoft Graph errors](https://learn.microsoft.com/en-us/graph/errors).

## Failure and lifecycle semantics

The existing `ApiDegradedState` variants remain unchanged:

- A settled exact missing permission returns `insufficient-scope` with the source
  string. No scope is invented from the provider name.
- Settled `none` returns `provider-error`, status 403, explicitly saying no
  particular missing permission was identified. A positive or unsettled fit
  contradicting `none` prevents settlement.
- Weak, ambiguous, malformed, oversized or unreadable evidence is an explicit
  `CalendarScopeReadingError`. Missing ports and permanent shared-transport
  failures propagate as operational errors. They never masquerade as `none`.
- Transient Jev unavailability stays pending in the installed shared port. There
  is no calendar-specific retry loop, fallback parser or human decision loop.
- Optional `CalendarRequestOptions.signal` flows from the Agent service through
  the connector and provider clients to the HTTP request and judgment reading.
  The existing composition-owned port lifecycle still applies. Interactive
  command cancellation and the best-effort account-label lookup are unchanged;
  the new option is available to callers that own an operation signal. Cancelling the
  reading does not repeat the calendar request, including a failed event write.
- HTTP 401, HTTP 429, Retry-After seconds/date parsing, provider pagination and
  event normalization stay mechanical. OAuth token-refresh cancellation itself
  is unchanged; the request signal is rechecked before the provider request.

## Qualification

Before production changes, the existing 32 OAuth/connector tests passed and the
8 added regression tests failed against the legacy code. The expanded suite
covers both providers, exact source selection, incidental/granted/multiple
permissions, none/unresolved/malformed/missing-port cases, complete protected
input, structural provenance, shared outage recovery/cancellation, no repeated
provider writes, and unchanged 401/429 mechanics. An Agent service test traverses
the actual service and connector and checks signal ownership.
