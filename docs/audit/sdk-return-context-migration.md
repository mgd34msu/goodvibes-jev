# Return-context migration for retired panes

Base: `cef1a3d529797d63ddb8e95f48904ec76c638dca`.
SDK source target: `17eae838461a6529135fe2cad41332d2dc46cb27`.

## Narrow migration

The former summary writer emits exactly `Open panels: ` followed by its pane
list, inside the generated `lines` array. The upstream target removes that
writer and adds `loadedReturnContext(raw)` at
[`runtime/session-return-context.ts`](https://github.com/mgd34msu/goodvibes-sdk/blob/17eae838461a6529135fe2cad41332d2dc46cb27/packages/sdk/src/platform/runtime/session-return-context.ts).

Jev adopts the public helper and removes the retired fields from the active
summary/hints types. The helper accepts legacy object records, removes their
own `openPanels` field, and filters only the exact generated line prefix
`Open panels: `, including its space. Case variants, quoted or embedded words,
the user's last prompt, the assistant reply and assisted narrative are left
unchanged. Unknown legacy fields and partial records are preserved. This is
not a new general summary validator or semantic text classifier.

New summary construction ignores any legacy pane hints at runtime. Local
SessionManager save/load/list/getMeta/rename and recovery read/write paths all
apply the migration. The real host fork/copy boundary is load followed by save;
SessionManager has no separate fork method. Durable persistence also uses the same manager. The existing load-last API
returns messages only, so its shape is unchanged; its stored metadata is
verified through the manager rather than silently expanding that API.

## Preserved contracts

- Pending approvals still use the host's structured count, or the existing
  `engine.runtime.pending-approval` reading when that count is absent
- Session schema version two, contract records, sticky explicit user-save
  retention, atomic writes and recovery scope/liveness are unchanged
- Ordinary reads do not rewrite old files; the migration appears in returned
  metadata and the next intentional save, rename, fork-copy or recovery write
- The older wire schema may still accept optional `openPanels` for read
  compatibility; it cannot make the local migration retain or emit that field
- TUI panel adapter/control routes remain a separate compatibility surface

## Acceptance

Focused tests exercise the public export, malformed outer values, partial
legacy records, exact-prefix negative controls, input immutability and
idempotence. Real disk roundtrips cover save/reload/list/getMeta, load-to-fork,
rename, durable persist/load-last and recovery load/copy/write. They preserve
tool outcomes, follow-up markers, version-two contract data, unknown metadata,
user-save retention and untouched sibling files. A synthetic reading proves
the existing pending-approval battery remains authoritative rather than a
restored keyword fallback. Adjacent session/schema/retention/recovery and
runtime-reading tests, independent review and normal build/type/API gates are
required before publication.
