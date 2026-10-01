# Security notes

GoodVibes WebUI is a local/operator surface over a daemon. It should keep
security ownership with the daemon and avoid creating duplicate secret or auth
stores in browser code.

## Trust boundary

- The daemon/control-plane API is the authority for auth, config, providers,
  chat, artifacts, and Knowledge/Wiki.
- WebUI is a browser client. It may cache UI preferences and recent chat ids, but
  it should not become a durable source of truth for daemon state.
- Binding WebUI to `0.0.0.0` exposes the Vite/WebUI surface to the local network.
  Use local firewall policy to restrict traffic to trusted LAN clients.

## Auth

- Username/password login goes through the daemon login route, a direct
  request without Authorization headers or cookies; only the returned browser
  session is stored.
- Operator tokens are accepted when pasted or scanned by the user, or handed
  off by a `#pair=` link, and always validated against the daemon; a rejected
  token self-clears.
- A pairing link's one-time token is captured and stripped from the URL
  immediately, so it never lingers in the address bar or a history entry, and
  the QR scanner never renders or logs the secret it carried.
- Browser token storage uses the SDK token store key
  `goodvibes.webui.token`.

Browser code must not read or scrape:

- `~/.goodvibes/tui/auth-users.json`
- `~/.goodvibes/tui/auth-bootstrap.txt`
- `operator-tokens.json`
- other daemon/TUI private auth files

GoodVibes secret refs such as `goodvibes://secrets/...` are daemon-side
credential resolution for downstream services. They are not WebUI auth tokens.

## Relay and step-up

A stored relay pairing lets the app tunnel calls through a rendezvous relay
when the daemon is unreachable directly. The tunnel is end to end encrypted
against the daemon's public key from the pairing, and the pairing itself
carries no identity, so storing it signs nobody in. The daemon gates
state-changing relay calls behind a WebAuthn step-up assertion; a mutating
call without a fresh assertion is refused, the passkey ceremony runs, and the
call retries once. A cancelled or unavailable ceremony surfaces the refusal
instead of skipping verification.

## Web Push

Push key custody is daemon-side. The VAPID private key never leaves the daemon,
and the browser fetches only the public key (`push.vapid.get`) to subscribe.
Push subscriptions are stored by the daemon (`push.subscriptions.*`). Push and
install require a secure (HTTPS) context; the app states this on plain HTTP
instead of failing silently.

## Network

Development topology:

- WebUI/Vite: `3423`
- Daemon/control-plane: `3421`
- HTTP listener/webhook surface: `3422`

The browser should normally use the WebUI origin and Vite proxy. The dev proxy
should connect to `127.0.0.1:3421` even when the daemon binds to `0.0.0.0`.
`0.0.0.0` is a bind address, not a client URL.

Do not expose the dev server directly to untrusted networks. A production
deployment should add explicit TLS, host allow-listing, and daemon auth policy.

## Attachments and artifacts

Chat attachments are uploaded to daemon artifacts before being referenced from a
chat message. The browser sends file bytes to the daemon as base64 through the
published SDK helper. Operators should avoid attaching secrets unless they intend
the daemon and selected model route to process them.

## Logging and screenshots

- Do not log raw tokens, passwords, or bootstrap credentials.
- Avoid committing screenshots that show private chat content, local secrets,
  provider keys, or sensitive Knowledge records.
- Documentation screenshots should use empty or non-sensitive states.

## Dependency and SDK safety

- Use the npm-published `@pellux/goodvibes-sdk` package.
- Do not point WebUI to a local SDK checkout for validation.
- Verify the installed SDK version with:

```bash
node -p "require('./node_modules/@pellux/goodvibes-sdk/package.json').version"
```

## Security issue checklist

When investigating a security-relevant bug, capture:

- WebUI version
- installed SDK version
- daemon `/status` version
- route or SDK helper used
- request payload shape without secrets
- response status and error code
- whether the issue occurs through same-origin proxy, direct backend URL, or both
