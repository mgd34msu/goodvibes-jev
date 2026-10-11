# Daemon inbox routing ownership

The daemon's actual Slack and email inbox factories connect the canonical
routing registration to the provider owners. Slack owner context may carry
`resolveRouteId`; `EmailInboxOwnerOptions` also has an optional `resolveRouteId`.
Callers without those optional ports preserve their no-route behavior. The
product's required routing registration must not be replaced by a fallback.

Only provider, conversation kind and sender digest reach the resolver.
Owner-authored persisted bindings choose the profile; message text, a semantic
classifier or a new default policy cannot choose it. Profile IDs are not route
IDs. Closed or failed optional routing does not fabricate a binding.

After awaiting the resolver, email rechecks source, account and observation
lifetime. Slack retains its adapter and owner fences. Revocation while a callback
is held must prevent the stale item from being persisted. These fences apply in
addition to the protected-source and provider-account boundaries, not in their
place.

The store and bridge contract remains in
[host channel/profile routing](daemon-remote-and-cluster.md#persisted-channel-and-profile-bindings).
Provider intake contracts remain in the [Slack](daemon-inbox-and-triage.md#slack-account-and-transport)
and [email](daemon-inbox-and-triage.md#email-complete-source-reads) sections of the
[inbox and triage contract](daemon-inbox-and-triage.md).

## Verification boundary

The active product suite
[`inbox-route-composition.test.ts`](../../products/daemon/src/test/runtime/inbox-route-composition.test.ts)
checks actual persisted assignments through both factories into `item.routeId`,
no binding, other-provider and wildcard resolution, closed resolution, and
source/account/credential revocation. Whole source-assertion coverage also needs
[`inbox-source-parity.test.ts`](../../products/daemon/src/test/runtime/inbox-source-parity.test.ts);
engine owner tests alone do not prove the product invocation boundary.

Use the [daemon's canonical focused-test procedure](../../products/daemon/docs/testing-and-validation.md#local-commands)
with those active suite paths. Synthetic provider inputs establish these ownership
and persistence boundaries; they do not establish live-provider parity.
Historical mappings, receipts and open acceptance are in
[THE-18](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure).
