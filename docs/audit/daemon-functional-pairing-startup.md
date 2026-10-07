# Functional daemon startup pairing

THE-18 remains **In Progress**. This bounded increment connects the admitted
CLI startup to the existing pairing renderer; it does not complete daemon
migration, native release, service adoption, or live device/account acceptance.

## Source contract and deliberate corrections

Reviewed source is `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, `src/daemon/cli.ts`, blob
`5e8e7aff5a82fbdc604d3a0d637078a35497e058`, particularly lines 687–715 and
841–867. Its PORT contract calls the existing shared companion-token owner,
then renders a QR with offers and posture through `core/pairing-banner.ts`.
That renderer's pinned blob is `94aa0e2f88307cf07932b43858b9dc2efa3f3a21`;
the local pair adapter is `396b3d60a8ce55add1959eeedd1a42f55162015e`.
The source/caller inventory remains partial; no whole-file completion is claimed.

The pinned startup used the stored companion token even when an explicit daemon
token overrode authentication. Startup now renders the effective daemon token;
the secondary HTTP listener token is never substituted. Local `pair` honors its
explicit token, then the process daemon-token override, then the existing stored
identity. Only the stored-file fallback is decoded as a token record. Overrides
remain literal credential bytes and are never adopted into persistent identity.

The bundle is served by the control-plane router, as already established by
`daemon/webui-command.ts` and `daemon-setup-commands-port.md`. The shared engine
origin resolver now derives bundled fallback from that binding. An optional
settled binding lets startup use the actual observed host/port after restart
settlement, rather than its intended configuration. The pre-bind diagnostic and
bound receipt retain their separate meanings. Explicit public URLs remain
authoritative, including separately hosted WebUIs with local serving disabled.
Direct TLS uses HTTPS at the actual listener port; proxy mode retains the plain
local HTTP binding unless an external public URL is explicitly configured.
Startup reads the listener owner's captured `boundScheme`, so a TLS setting
changed during held boot cannot relabel a socket that already bound. This adds
no TLS live-restart policy. Offline pair uses the declared configuration.
The exact shipped `http://127.0.0.1:3423` placeholder follows the webui command's
existing equality rule; this is not evidence about who set a stored value.

Startup does not persist a public URL or runtime overrides. The existing
`ensurePublicBaseUrl` helper still only writes an empty value. A local reprint
may carry its declared nonzero `--port`, but cannot observe another process's
ephemeral endpoint. Zero/invalid local ports refuse before reading credentials.

## Output and lifecycle ownership

The original CLI printed pairing to stdout unconditionally. This adaptation
restricts automatic credential-bearing output to an actual interactive stdout
TTY or a composed caller's explicit trusted local `pairingOutput` port.
Ordinary redirected/service diagnostic stdout, stderr, logs and fatal errors
receive no token. Explicit `pair` remains the intentional one-shot reveal.
The shared renderer produces both the QR and its copyable fragment-bearing link.

The startup pairing port is invoked only after the existing host admission,
boot and config-restart settlement fences. Its failure, synchronous shutdown,
or listener loss prevents later readiness and uses the existing complete graph
drain and terminal exit owner. No lifecycle or token owner is duplicated.
The bundled fallback requires the same configured bundle precedence and a
readable app shell. Disabled/missing bundles and malformed credential-bearing,
query/fragment, non-HTTP(S), or wildcard URLs yield a value-free unavailable
notice. Explicit external URLs are configuration authority, not a claim that
this process verified a remote deployment.

## Verification boundary

All fixtures use owned scratch homes, synthetic identity/credentials and
loopback listeners. Source-level host tests exercise the actual ephemeral bound
port, fetch the served app shell, authenticate HTTP with the emitted link token,
and reject the stored/secondary token when overridden. They cover headless
non-disclosure and held graph drainage after pairing-output failure, shutdown
or listener loss. Resolver and adapter regressions cover configured/bound IPv6,
public URL precedence, missing bundles, malformed and empty query/fragment
delimiters, literal JSON-shaped overrides, and invalid local ports.
An owned direct-TLS host serves the printed HTTPS link and authenticates its
token using a generated loopback certificate trusted only by that test client;
certificate verification stays enabled and no system trust is changed.

The emitted launcher fixture uses the real composition port, a synthetic inbox,
and a synthetic static bundle. It checks HTTP and WebSocket authentication with
the printed token, rejects wrong token classes, compares explicit `pair` output,
and verifies exact settings/identity bytes survive runtime overrides and exit.
An actual Bun pseudo-terminal proves default TTY admission without injecting
the pairing-output port; ordinary redirected output is checked independently.
This proves served origin and authentication, not browser rendering, camera QR
scanning, remote CORS/reverse proxy configuration, or real device registration.
No account, persistent device grant, service/security/network setting, release,
deployment, Legacy IMAP operation or settlement-security behavior is changed.
