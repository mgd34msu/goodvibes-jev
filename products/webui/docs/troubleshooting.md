# Troubleshooting

## Dev server is not reachable

Check the Vite bind address:

```bash
sed -n '1,120p' /tmp/goodvibes-webui-vite.log
ss -ltnp | rg ':3423'
```

Expected network bind:

```text
0.0.0.0:3423
```

If Vite only binds to localhost, inspect the resolved TUI web setting:

```bash
goodvibes web --json
```

For one-off development, override the bind:

```bash
GOODVIBES_WEB_HOST=0.0.0.0 GOODVIBES_WEB_PORT=3423 bun run dev
```

If the page is reachable locally but not from another LAN device, check firewall
rules and confirm traffic to `3423/tcp` is allowed from the local network.

## Page loads but API calls fail

Check daemon status:

```bash
curl -sS http://127.0.0.1:3421/status
```

If auth is required, use the Admin page or an authenticated request. Confirm the
daemon/control-plane listener:

```bash
ss -ltnp | rg ':3421'
```

If the daemon binds to `0.0.0.0`, the Vite proxy should still connect to
`127.0.0.1`. Do not use `0.0.0.0` as a browser or proxy target URL.

## Auth fails

Expected auth paths:

- username/password through daemon login
- explicit operator token pasted by user and validated with daemon
- browser token storage under `goodvibes.webui.token`

The browser must not read:

- `~/.goodvibes/tui/auth-users.json`
- `~/.goodvibes/tui/auth-bootstrap.txt`
- `operator-tokens.json`

If token auth works but username/password fails, inspect local auth status from
Admin after authenticating with a valid token. Check that the daemon reports the
expected user store and username list.

## The QR scanner will not open

Every way the scanner can fail renders its own titled explanation with a next
step, never a dead control. The named failures:

| Failure | What it means |
| --- | --- |
| Scanning needs a secure (HTTPS) connection | The page is on plain HTTP, so the browser withholds the camera; serve over HTTPS (for example `tailscale serve`) or paste the token instead |
| This browser does not offer camera access | No camera API is exposed to web pages; use another browser or paste the token |
| This page does not have permission to use the camera | Camera permission is blocked for this site; allow it in site settings and retry |
| No camera was found on this device | The browser reported no usable camera |
| The camera is already in use | Another app or tab holds the camera |
| The camera could not be started | The camera exists but failed to open |
| This browser has no QR decoder available | Neither the built-in barcode detector nor the fallback decoder could load |

A scan that decodes but is rejected by the daemon (an expired or malformed
pairing QR) surfaces as a banner on the sign-in screen, never a silent
bounce.

## Wake word never reaches "listening"

Wake detection starts only when all of these hold: the models are provisioned
on the daemon (the setup button in the wake settings shows the download size),
`voice.wake.enabled` is on, and this surface's own opt-in
(`voice.wake.surfaces.webui`) is on. The settings surface renders the
resolver's blockers verbatim, so read the stated reason there first; a missing
speech gate artifact or a refused microphone permission each name themselves.
While the surface opt-in is off, the tab deliberately never asks for the
microphone.

## Chat does not show new messages immediately

The expected send behavior is:

1. Composer clears.
2. A local optimistic user message appears immediately.
3. The message transitions to sent or failed.
4. Assistant output streams or appears after daemon message refresh.

If messages only appear after the next send:

- confirm the served app is on the latest cache-bust version
- clear Vite optimized deps and restart the dev server
- check browser console errors
- verify `sdk.chat.messages.create` returns successfully
- verify companion chat events are connected for the active session

## `SESSION_NOT_FOUND`

This usually means browser local storage contains a stale companion chat session
id. The app should prune stale ids when daemon list/get/message calls return
`SESSION_NOT_FOUND`.

Manual recovery in browser dev tools:

```js
localStorage.removeItem('goodvibes.webui.activeCompanionSessionId')
localStorage.removeItem('goodvibes.webui.companionSessions')
```

Then refresh the page.

## Chat stores user message but no assistant reply

Plain WebUI chat must use companion chat:

- `sdk.chat.sessions.create`
- `sdk.chat.messages.create`
- `sdk.chat.events.stream`

Do not send plain chat through:

- `sessions.followUp`
- `sessions.messages.create` as a storage-only fallback

If a user message persists without a reply, check whether the send path used the
wrong session API or whether companion chat SSE returned `turn.error`.

## Provider or model is rejected

Provider/model routing must use daemon-valid provider/model semantics.

Expected behavior:

- provider selection is separate from model selection
- model options update based on selected provider
- current daemon model is selected through model APIs
- chat message sends do not include provider/model

If the daemon returns "No provider available" or a provider-qualified registry
key error, inspect:

```bash
curl -sS http://127.0.0.1:3421/api/models/current
```

Use authenticated access where required. Runtime provider ids such as
`openai-subscriber` may differ from catalog provider prefixes such as `openai`.

## Attachments fail

Attachment send flow:

1. `sdk.artifacts.create`
2. `sdk.chat.messages.create(sessionId, { body, attachments })`

Common causes:

- artifact upload failed
- daemon rejected an unknown artifact id
- message payload put attachments in `metadata` instead of `attachments`
- provider/model was incorrectly attached to `messages.create`

Unknown artifacts should surface as daemon errors instead of silently dropping
the attachment.

## Knowledge shows Home Assistant or Home Graph records

Regular Knowledge/Wiki should use regular Knowledge routes only. WebUI should
not call Home Graph routes and should not add client-side Home Graph filters.

If Home Graph records appear in regular Knowledge by default:

1. Keep WebUI payloads unchanged.
2. Record the endpoint, payload, and returned ids/titles.
3. Report it as an SDK/daemon scoping issue.

Do not "fix" this by filtering text, tags, or ids in WebUI.

## Vite still serves old code

Clear optimized deps and restart:

```bash
rm -rf node_modules/.vite
setsid node ./node_modules/.bin/vite --force > /tmp/goodvibes-webui-vite.log 2>&1 < /dev/null &
```

Verify the served app version (match the version in `package.json`):

```bash
curl -sS --max-time 3 http://127.0.0.1:3423/ | rg "$(node -p "require('./package.json').version")"
```

Verify installed SDK:

```bash
node -p "require('./node_modules/@pellux/goodvibes-sdk/package.json').version"
```
