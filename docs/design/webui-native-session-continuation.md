# Native continuation of an owned hosted session

The conversation composer and steerable Fleet process actions first ask
`workLedger.turn.session` for the host's session kind. Only an explicit `legacy` result selects the existing steer and
follow-up composer. A native result opens the native intake workflow scoped to
that session and paired project. Unavailable discovery, changed connections and
unsupported authority never fall back to body-only legacy ingress.

## Original source and prior context

The capture request may name `continuation: { sessionId }`; it cannot submit a
transcript, workspace, principal, context digest or permission. The native host
proves ownership from the original strict dispatch journal, the authenticated
paired principal, the project and the hosted manager's real workspace. A matching
title or origin surface is not evidence. New native sessions also carry a
host-written persisted classification marker, so missing dispatch provenance
returns recovery-required instead of downgrading them to legacy ingress. Continuation also requires the existing
`write:sessions` scope alongside native intake scopes.

The host captures the last completed, durably stored conversation checkpoint.
Streaming assistant blocks are not stable source and are never captured. The
snapshot is complete and bounded to 128 messages / 128 KiB; exceeding either
limit is refused without truncation or generated summarization. Session ID and
exact role/content messages determine its SHA-256 revision. Both the snapshot
and original input are immutable, and their combined source revision binds Jev's
routing, extraction and admission decisions.

This is explicitly submission-time completed context. A reply still running at
submission is excluded. A later append may be present when the queued turn runs;
it does not add requirements or authority to the original source. The captured
prefix must still match before intake admission/publication and hosted-turn
dispatch. A replaced,
compacted or truncated prefix refuses further action without silently refreshing
context or rerolling terminal admission. Read-only inspection remains available.

Original text is retained byte-for-byte as a JavaScript string, including repeated
requirements, CR/LF, whitespace and Unicode. Original criteria continue to be exact
UTF-16 ranges in this input. Prior conversation is quoted context, not another
source of requirements. A `work` disposition carries the same frozen context into
native execution, planning and tool admission; it does not become a conversation
turn or a human approval request. Once published, work retains its independent
immutable context and the existing native ledger/authority/scope fences; later
hosted-session compaction does not rewrite its source.

Generic ledger and contract reads omit the prior transcript. Planner, unit and
fix-plan task metadata also omit it. Live native source bindings provide context
only to the provider request, outside public task/conversation records. The
shared provider retry path rechecks that binding immediately before every actual
attempt, including after backoff; retry policy and Jev decision ownership are
unchanged. Model-generated work results may still discuss relevant context.

## Native delivery and queue ownership

The host obtains a genuine process-local turn permit from the real terminal
admission operation. It resolves the selected session from that source, allocates
a fresh canonical broker input/correlation identity, and commits the strict
source-to-session association before executing. The continuation never creates
a replacement session, and preparation failure never kills the existing one.

A busy native session uses a host-owned FIFO separate from ordinary steer input.
Its durable status is `queued`; the retained live permit enters the real runtime
only after preceding native ownership and any existing runtime turn have drained.
The runtime's immediate-entry guard remains intact. Ordinary queue acceptance is
never reported as completed native delivery. Legacy sessions retain their current
steer/follow-up behavior.

The journal fences all unresolved claims for the selected session against other
processes. A process may append behind only its own live claims. After restart,
queued or dispatched inputs are recovery-required; serialized data cannot recreate
permits or replay effects. Retrying the same original identity reads its existing
claim. Cancellation fences only that input's permit, and cancelling a queued
input does not cancel or wait for the unrelated running input. Cancellation does
not undo effects already performed.

## Browser recovery and boundaries

The browser durably saves the original command and session selector before
mutation. Saved lists are scoped to endpoint, paired owner, project and session;
the Work/New form excludes continuation records. Reopening and Inspect perform
reads only. A deliberate new request allocates new IDs even for identical text.
A lost acknowledgement retains its original identity for inspection. Closed
sessions expose inspection/cancellation while refusing new submission.

The WebUI conversation composer and steerable Fleet process actions share one
session-classification boundary and native intake form for existing native-owned
hosted sessions. Their saved originals use the same session-scoped journal, so
moving between these surfaces only inspects previously retained input. Fleet's
legacy compact steer and browser detach retain their existing behavior; native
receipts do not use the legacy “Steer sent” toast.

Per-hunk Session Changes comments now use the same classification and lifecycle
through [source-aware selected-change capture](webui-native-diff-comments.md).
Their exact original comments remain separate from host-resolved complete hunk
and checkpoint evidence. The legacy formatter remains available only after an
explicit legacy classification.

Agent remote creation, inbound-derived authority, other ordinary hosted ingress and broader planning retirement are separate migrations. The
recorded loopback/Chromium proofs establish orchestration and recovery behavior;
they do not claim live-provider semantic calibration or independent settlement
security acceptance.
