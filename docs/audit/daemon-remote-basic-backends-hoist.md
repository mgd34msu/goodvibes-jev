# Daemon local and Docker backend hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`, remote backend
`types.ts`, `local-process.ts` and `docker.ts`.

The files now live under engine `runtime/remote/host/backends`, exported through
the existing runtime operations namespace. `RemoteHostCredentialStore` exposes
only `resolveRef`; `RemoteHostLogger` exposes the three existing log levels.
The daemon's broader credential/config implementation is not copied or coupled
to these reusable backends.

## Preserved contract

- Local execution passes discrete argv without a shell, honors quoted/escaped
  tokens, appends literal payload args and preserves cwd/env/stdin precedence
- Omitting the optional local executable allowlist keeps the original operator
  behavior. A supplied list compares exact executable strings, not basenames
- Docker keeps the remote-shell command/args contract, passes stdin through
  `docker exec -i`, and resolves host references into `DOCKER_HOST`, never argv
- Unknown peer kinds, empty commands and unresolved host references refuse
  before spawning; timeouts retain the caller duration and fixed ceiling
- This library does not invent an admission route. The existing daemon route's
  admin/approval boundaries must remain in force when composition lands

## Regressions corrected

The imported sources pass 17 focused cases and fail three:

1. A supplied empty allowlist allowed every executable. It now permits none,
   matching the declared contract that only listed commands may run
2. A trailing escape was silently removed by the tokenizer. Incomplete escape
   grammar now refuses like an unterminated quote
3. An empty quoted executable reached the process boundary. It now gives the
   backend's typed bad-command refusal before any spawn

These are explicit option membership, token grammar and string-length checks,
not guesses about command meaning. No heuristic permission fallback is added.

The combined backend/process/registry run passes 60 guarded tests. Every Docker
spawn is intercepted; the only real processes are isolated local runner
fixtures. The runner's inherited-pipe fixtures now also ignore SIGTERM to
verify the SIGKILL cleanup path. No provider or credential-store connection is
used.

SSH, cloud credentials, the all-backend factory, dispatcher and composed route
proof remain later slices. The original combined upstream backend/route-gating
test files are not marked fully migrated until those dependencies land.
