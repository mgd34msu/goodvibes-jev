# Standalone daemon send

This ports the six `src/daemon/send` modules and the CLI surface catalog from
`mgd34msu/goodvibes-daemon` revision `254699bf5d834cdca41436211ada1ae32bf89258`.
THE-18 remains In Progress: default serving, remaining provider composition,
cluster eligibility, native packaging and live acceptance are separate work.

## Command and ownership

The canonical emitted `goodvibes-daemon` executable accepts `send [message]`,
`--channel`, `--to`, `--title` and `--list`. It awaits stdin when no argument is
provided. Parsing/help failures happen before configuration acquisition. A named
channel is selected exactly, and an unnamed channel requires exactly one enabled
configured destination. Canonical gateway, service, routing, delivery and surface
feature gates still apply. Disabled/ambiguous destinations do not fall back.

Send remains a first-token command. Relocated homes are supplied through
`GOODVIBES_HOME` and `GOODVIBES_DAEMON_HOME`, with `GOODVIBES_WORKING_DIR` selecting
the workspace. It uses the same selected ConfigManager and daemon tier as the
other adapters, passing that identity into SecretsManager. Configuration retains
its existing migration and refusal rules. Only an admitted actual delivery
constructs SecretsManager, SubscriptionManager, ServiceRegistry, ArtifactStore
and ChannelDeliveryRouter. No host graph, listener, inbox, discovery task or
notification queue starts. The unused subscription service does not perform its
legacy-store fold during this one-shot acquisition.

Thirteen upstream surfaces are supported: Telegram, ntfy, Discord, Slack,
Google Chat, Signal, WhatsApp, iMessage, Microsoft Teams, BlueBubbles, Mattermost,
Matrix and generic webhooks. Shared canonical owners resolve their declared
credential references. Registry credentials retain precedence; a configured but
unresolved surface fallback cannot silently become an environment credential.
Absent optional bridge authentication remains distinct from failed configured
credentials. No credentials are created or provisioned by the command.

## Message, receipt and lifetime

The explicit command supplies outbound authority for its body. It does not grant
inbound-source processing authority or route arbitrary text through automatic
notification metadata-only policies. Per-surface transformations preserve the
upstream explicit-send markup contract. Telegram stays plain text without a
parse mode; Discord/Slack markup and mentions are escaped. Existing channel
length limits remain. Client URL auto-linking and cosmetic formatting behavior
are not claimed eliminated. No artifacts or control-plane links are synthesized.

Success means the send owner accepted the request. It does not prove arrival or
reading at a recipient. Telegram and Slack bot requests require literal protocol
acknowledgement; response URL HTTP rejection is no longer successful. Other
HTTP-based owners retain their documented transport-level acknowledgement.
Missing response IDs are valid success; arbitrary provider IDs and capability
URLs never appear in CLI output. Failure says delivery was not confirmed,
publishes only structural status evidence, and adds no command or notification-queue retry.
The existing checked-address connection fallback for pinned webhooks remains.

Explicit sends opt into the existing ntfy duplicate override, so repeated calls
and a repeat after a failed attempt still reach transport. Ordinary notification
deduplication is unchanged. The command awaits the actual credential, fetch and
body owner. Successful transports that do not need their body cancel and await
the retirement attempt. A rejected cleanup is reported structurally without
reversing received acceptance or triggering a duplicate send. No detached timeout race is introduced; the existing per-provider
deadlines remain, and no universal cancellation/deadline guarantee is claimed.

## Diagnostic publication

The preceding channel diagnostic prerequisite withholds credential-bearing URLs
and known capability-derived receipt IDs without changing actual requests. Send
additionally selects structural diagnostics before loading configuration, where
an owned malformed-settings fixture proved that parser errors could echo a
credential through migration logs, ingestion logs and direct stderr. The selected
mode withholds borrowed parse text and malformed-reference descriptors. A
quarantined declared credential holds a one-shot send before fallback resolution,
so a skipped setting cannot silently select another account. It retains
file/key identifiers and the
original private ConfigError for its owner. Existing default diagnostics and
configuration semantics remain available to other callers.

Secret-reference, registry and secret-store read owners have the same additive
structural mode. Delivery credential resolution selects it; the send stack also
selects it on its concrete registry and secret store. Provider error/reference
text, malformed-reference hostnames and unvalidated store-envelope fields remain
private. Resolution results and private errors retain their original semantics.
The pinned failure-text inventory retains its JEV disposition. Its original
query-name credential heuristic is removed: this command does not classify or
republish arbitrary provider error wording or query values at all. The shared
structural status projection supplies its public diagnostic, while original
private failures remain with existing semantic retry owners. No keyword-based
redaction or substitute semantic guess is added.

These modes are projections at known publication sites, not semantic classifiers,
global logger suppression, or a claim that every application log is public-safe.

## Verification and remaining acceptance

Owned source tests cover parser/admission ordering, selected settings and secret
ownership, thirteen-provider routing, actual credential-reference wire values,
private errors and IDs, malformed settings stderr, explicit repeat behavior and
held credential/fetch/body retirement. The executable fixtures use the actual
package launcher and an owned ntfy loopback service; no real account, provider
credential, messaging action or host deployment is used. Exact compiled proof,
full local gates, independent review and CI are recorded with the implementing PR.
