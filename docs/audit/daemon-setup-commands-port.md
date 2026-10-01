# Daemon pairing, web serving and wake-model command adapters

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

The source checkout's commit and the contents of all seven mapped files were
verified when this slice was integrated with the current engine. The Git blob
IDs below record that content baseline, so a later upstream revision with the
same paths cannot silently substitute different source. Upstream reconciliation
remains a separate final migration check.

The resumed comparison on 2026-10-01 verified these same seven blobs against
upstream `254699bf5d834cdca41436211ada1ae32bf89258`. None changed. The held
setup slice and its reviewed safety corrections therefore remain applicable
on Jev main `5957c2be53b6fd5f393885ca00403a9eb4ff8ac6`; see
`daemon-upstream-reconciliation-2026-10-01.json` for the complete content ledger
and the companion audit for outstanding upstream acceptance.

| Pinned source file | Git blob |
|---|---|
| `src/daemon/pair-command.ts` | `396b3d60a8ce55add1959eeedd1a42f55162015e` |
| `src/daemon/webui-command.ts` | `8d7ceca1c0b386e4e9674ff1e488816177689a92` |
| `src/daemon/provision-wake-model.ts` | `2ee25598d71e2779795e59725a9b1f1833488800` |
| `src/core/pairing-banner.ts` | `94aa0e2f88307cf07932b43858b9dc2efa3f3a21` |
| `src/test/daemon/pair-command.test.ts` | `56ea43eb18a86b132e534fb69da872e4f29d18ae` |
| `src/test/daemon/webui-command.test.ts` | `df0dcfb4658e4a64f9ba21de9efbf8948a073c6f` |
| `src/test/daemon/provision-wake-model.test.ts` | `a42e1c836a3fa85a736760d4fe3936d8396e44ba` |

The four modules `daemon/pair-command.ts`, `core/pairing-banner.ts`,
`daemon/webui-command.ts` and `daemon/provision-wake-model.ts` now live in the
partial daemon product. Their three original suites retain every assertion.
Seven explicit PORT mappings record this slice. These adapters depend on the
canonical engine pairing, voice and terminal-shell APIs; the pairing command
uses the already-hoisted public WebSocket transport.

Local pairing reprints the existing token without mutating settings. Remote
pairing preserves the explicit confirmation flag, dry-run plan and named
handoff verb; it renders the returned link or reports missing-origin output.
The shared banner preserves QR, offer and posture rendering. Fixed address
equality, declared offer kinds and link grammar remain code as the inventory
requires.

Web serving preserves its explicit posture flags, bundle validation, configured
origin, caller-selected URL and reported restart requirement. Enabling serving
does not change listener posture unless the caller supplies that flag. The
module composes neither a listener nor the WebUI product. Wake provisioning
continues to delegate model identity/checksums and managed-root derivation to
the engine, preserving opt-out and strict/degraded exit behavior.

The 45 original tests pass with 116 assertions. Pairing uses synthetic token
reads and scripted socket replies, never a real token store or remote mint.
Web commands use in-memory settings, owned temporary bundle files and injected
host probes. Wake tests exercise the actual provisioning policy with a fetch
fixture that throws, or inject a fixture provisioner; no model is downloaded.

## IPv6 origin correction

Additional offline probes found that the pinned web command and shared pairing
origin builder interpolated an unbracketed IPv6 bind host directly into an HTTP
URL. Both now use the shared `formatHttpOrigin` formatter, exported by the
pairing subpath. Bare and already-bracketed IPv6 inputs produce one valid
authority; hostname and IPv4 formatting retain their existing form. Explicit
public URLs remain authoritative. Product enable/status receipts and local
pairing links have dedicated IPv6 regressions, including the bracketed
loopback case. Web command posture uses the existing origin-posture function,
and custom bindings are no longer described as necessarily using all interfaces.

The executable command dispatcher, remaining boot tasks, built-in intake and
triage, packaging, source reconciliation and full product parity remain open.
This is daemon command code, not a port of the separate browser UI product.

## Complete settings transitions

Review reproduced a pinned-source ordering defect using the real ConfigManager:
`enable --loopback` could persist serving on a network binding before a managed
host-mode lock refused the requested narrowing. The command now requires the
canonical `setDaemonValues` capability. It prepares the bundle, listener
posture, serving flags and derived URL together, validates every field and
managed lock, and replaces their single daemon settings file atomically. Live
values and observers are updated only after the complete write. This does not
add transactions across files or concurrent processes. Credential-bearing keys
are outside this batch capability.

The public URL is also prepared before writing. An explicit posture change
continues the default URL when it exactly matches the previously computed
serving origin (ignoring a trailing slash). This is an equality-based command
rule, not proof of who set the old value. A distinct custom URL is preserved;
without an explicit posture change, an existing non-placeholder URL is kept.
This corrects the ordinary enable-then-LAN sequence that otherwise left pairing
links pointing to loopback. Failure to update a required generated URL now
refuses the whole transition instead of enabling with mismatched links.

Real-manager regressions check locks on every updated field, previously enabled
and disabled serving, both posture directions, fresh-reader and exact-file
preservation, the pairing URL sequence and custom URL retention. Engine batch
tests cover read-only/ownership refusal, a real filesystem write failure,
complete snapshots in observers, invalid values and value-free diagnostics.
