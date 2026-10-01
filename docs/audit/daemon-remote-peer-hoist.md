# Daemon remote peer registry hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
`src/daemon/handlers/remote/peer-registry.ts` and its matching test.

The host backend registry now lives in engine
`sdk/src/platform/runtime/remote/host/peer-registry.ts`, exported through the
existing runtime operations namespace. Its separate handler store keeps
`.goodvibes/tui/operator/peer-registry.sqlite` and the original table schema.

## Preserved contract and decisions

- Four explicit backend kinds: Docker, SSH, cloud terminal and local process
- The original per-kind fields, optional defaults, string-port normalization,
  allowlist cleanup, credential-reference requirements and Docker-host checks
- Required references use both the exact `goodvibes://secrets/` prefix and the
  existing secret-reference parser. The weaker general config prefix-only
  classifier cannot replace this check
- Register/upsert, primary-key lookup, sorted listing, remove, restart
  persistence and typed corrupt-row refusals, including removal of bad rows
- Read validation uses JSON types, declared enums, port bounds and reference
  grammar. It does not infer meaning from text and adds no judgment fallback

All original test assertions remain. Added tests preserve normalization and
full-parser refusal, exercise twelve concurrent registrations across restart,
and verify idempotent close plus post-close refusal.

## Lifecycle correction

The daemon starts registry initialization in the background. Previously a
synchronous teardown before that promise completed could leave a newly open
database behind. The regression failed against the imported implementation
(30 tests passed, one failed). Initialization now records its generation;
closing during initialization closes the late database and rejects that init.
A later explicit initialization can reopen it normally.

The focused registry plus handler-store suites pass 53 tests across four
files. These tests use only isolated fixture databases and no credentials.

## Unresolved upstream composition gap

The pinned daemon constructs the registry but has no production call to its
`register` method. Its integration tests seed SQLite directly. Review of the
daemon CLI, scripts, production source and engine remote catalog found no
operator backend-registration path. External consumers outside these sources
have not been established.

The separate distributed-runtime manager owns paired peers and work items,
without backend configuration. Its real `enqueueWork` requires a peer with the
same ID; the upstream surface test uses a permissive manager stub instead.
Therefore the faithful registry hoist does not establish remote usability.

A later agreed composition slice must establish the intended operator path,
preserve authentication/admin boundaries, register the backend and matching
manager peer as appropriate, invoke through the normal route, prove restart
persistence, and refuse malformed or raw-credential input. No new route,
descriptor, user configuration or provider connection is introduced here.
