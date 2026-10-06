# Source-aware native selected-change comments

Session Changes comments share the host-owned session classification boundary used
by the conversation and Fleet composers. Only an explicit `legacy` response mounts
the prior trimmed, excerpt-prefixed steer/follow-up composer. Native discovery,
source preparation, authorization or delivery errors never select that path.
The local “mark reviewed” indicator and explicit hunk-revert workflow are separate.

## Exact original and host-owned evidence

A native comment submits the complete textarea value as the original input. It
never becomes a browser-generated instruction containing a diff excerpt. The
continuation selector contains the existing session ID and a strict selected-diff
precondition: source kind, full-diff SHA-256 revision, zero-based file/hunk indexes,
and, only for workspace mode, the chosen checkpoint baseline ID. The host supplies
the digest on the original diff read, so plain-HTTP LAN clients need no secure-context
Web Crypto API. Capture independently checks the digest again. No diff text,
file label, transcript, project owner or authority is accepted from the browser.

The native host independently proves paired principal, project, native session and
actual workspace ownership through the existing hosted dispatch journal. It reads
its real checkpoint manager and checks the same read scope as the original diff
surface: `read:sessions` for session aggregates or `read:checkpoints` for workspace
baseline comparisons. Existing native intake and continuation scopes remain
required. The browser also preflights the selected source's read scope.

The full-diff revision must match the host's current read. Content-equivalent
session checkpoint endpoints may advance before capture; the host records their
current provenance, and the browser's older display label grants no authority.
The host then selects
one complete raw file preamble and hunk, with exact line endings and no excerpt
cap, and freezes it with explicit checkpoint provenance. Session-stamped aggregates
and workspace-to-working-tree snapshots remain distinct claims. A session-stamped
aggregate describes the checkpoint endpoints; it does not prove exclusive file
authorship by that session. Binary, missing, malformed, stale and oversized
selections fail explicitly. The full source diff is limited to 4 MiB, the selected
hunk plus preamble to 64 KiB, and the combined continuation to 128 KiB and 128
completed messages. Neither source nor selected hunk is truncated.

The completed conversation, selected hunk evidence and exact original comment are
separate fields bound by one immutable source revision. The original comment is
the only source of requirement spans. Prior messages and selected code are quoted
evidence, never an instruction to obey embedded code comments. Jev owns work versus
conversation routing and admission. Existing native work execution and hosted-turn
FIFO consume the bound context without another human approval step.

After capture, later working-tree changes do not rewrite the snapshot. Retrying
an existing input retains its first evidence instead of recapturing a new hunk.
The existing session/transcript prefix and live authority fences remain in force;
normal read-only inspection remains available for uncertain outcomes. Private
provider-bound context is kept out of generic ledger and planner task metadata.
Jev's semantic evidence retains source kind and exact diff material; full host IDs
and checkpoint provenance remain frozen in source/provider bindings. Protocol
identities are validated separately from raw-content privacy scans, which still
inspect complete code/comment material, including prefixed diff lines.

## Browser durability and recovery

The existing strict IndexedDB original journal stores the exact comment and
identity-only selector before mutation. It stores neither host evidence nor a
permission. Repeated deliberate identical comments have distinct request/input IDs.
Repeated submit events while pending cannot allocate another input.

A selected-hunk sheet lists originals for that exact selector and session. The
ordinary native session/Fleet continuation view can inspect all of that session's
saved originals, including earlier comments whose current displayed diff changed.
Work/New continues to exclude all session-continuation records.

Reopening, reload, saved selection and Inspect perform reads only. Ambiguous
capture, admission or delivery responses retain the same original for explicit
reconciliation. They do not automatically retry mutations or silently fall back.
Close detaches local work without claiming remote cancellation. Dedicated native
cancellation retains the existing durable owner/FIFO behavior. A connection or
session change retires the selected-hunk sheet; selecting the new connection's
change again is explicit. Closed sessions permit existing inspection/cancellation
without accepting a new comment.

The browser uses the shared strict hunk selector and checks it against the displayed
file and complete hunk before offering native submission. This prevents a tolerant
display parser's indexes from silently selecting another source. Header-looking
added/removed lines remain hunk body, and a final newline is not a fabricated
blank context line.

## Verification boundary

The regression suite combines immutable-journal and browser-service tests, DOM
classification/source-selection and interruption tests, and real daemon/checkpoint
HTTP recordings replayed through the production WebUI in Chromium. Browser results
must be established by the exact-head CI artifact rather than inferred from DOM
success. Provider/Jev responses in those tests are owned synthetic fixtures; they
do not establish live semantic calibration or independent settlement-security
acceptance. Agent/TUI and other source-ingress migrations remain separate.
