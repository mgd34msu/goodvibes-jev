# Codebase review — remediation record

## Status

The 62 reported issues (R01–R62) have implementation fixes. The original review baseline was `d8fa6304e093b42e318dfb24024d7bcaf82b08f9`. This record describes remediation of those findings; it does not claim an exhaustive audit of every repository file.

Resolved findings are retained below as explanations of the original defects. Their locations refer to the reviewed checkout; the acceptance paragraphs describe intended behavior, while the validation section records what was actually run. Withdrawn claims, checker noise and coverage bookkeeping have been removed.

## Implemented changes

| Findings | Result |
|---|---|
| R01–R07 | Bash documentation labels are positional data; terminal links reject control sequences; authenticated transports enforce destination origin; HTTP listeners share revocation authority; browser WebSockets enforce Origin; Teams credentials go only to trusted HTTPS origins; incomplete provenance requires approval. |
| R08–R12 | Failed snapshots retain recoverable journals; corrupt journals preserve their valid prefix; deleted/contradicted memories and obsolete edges are reconciled; space deletion includes revisions and enrichment state; running automation jobs survive pruning; note transactions serialize across processes using a SQLite-owned lock that releases on process death. |
| R13–R20 | Relay handoffs survive remount without replay; stale authentication results cannot erase newer credentials; artifact cancellation interrupts stalled producers; approval cards advance; Ctrl+C bypasses debounce; late voice transcription respects draft edits and release; MCP reload retries dirty state; calendar token failures remain in the correct flow. |
| R21–R30 | Evicted asynchronous memo entries stay evicted; successful deliveries are not resent after receipt/routing persistence failure; failed ntfy ingress remains retryable; phone pairing recovers from network/malformed responses; saved sessions restore before persistence; disconnected views poll; knowledge events invalidate the entire prefix; unknown users perform password hashing; OAuth HTML is escaped and unrelated callbacks leave valid login pending. |
| R31–R39 | Sandbox status describes the actual non-isolating local backend; invocation schemas enforce scalar bounds and array cardinality; empty HTTP success bodies remain valid; browser and native factories retain options/defaults; pagination uses timestamp/ID order; Worker queues honor body limits; relay uploads preserve bytes; telephony resolves secret references. |
| R40–R52 | Judgment cascades respect confirmation; question/feature key collisions fail explicitly; unresolved selection evidence survives reduction; inferred leap days choose a valid future occurrence; remote process capture is bounded; native providers forward authentication; incomplete model streams stay incomplete; Gemini caches expire by TTL without invalidating concurrent callers; embedding dimensions use the documented REST shape; Copilot and SSH detect credential rotation; Discord ingress checks freshness and replay. |
| R53–R62 | Checksum manifests reject empty/malformed/duplicate entries; installer compensation covers metadata and stop attempts before publication; reusable workflows pin their setup action to its owning repository; judgment output participates in orphan pruning; retained release entry points refuse private workspace publication before mutation; action inputs enter the shell through environment variables; private-IP redaction is complete; artifact directories are private, including existing stores, and new files use mode 0600. |

## Contract corrections and operational details

- R06: the built-in public Teams Connector origin is `https://smba.trafficmanager.net`; another deployment origin must come from trusted operator configuration. Redirects cannot carry the token elsewhere. See [Microsoft Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0).
- R31: this corrects the reported isolation capability. It does not add a VM backend; local process execution remains explicitly non-isolating.
- R49: the current REST field is `embedContentConfig.outputDimensionality`. The original recommendation to move the field to the top level used a deprecated shape. See [Gemini embedding REST contract](https://ai.google.dev/api/embeddings).
- R48: replaced Gemini cache resources remain available to active calls until their server TTL expires.
- R12: note stores retain a small `.writer.sqlite` sidecar. It owns serialization only; note content remains in the existing JSON store. Removing a live sidecar would split lock ownership, so normal operation retains it.
- R62: opening an existing artifact store changes its directory mode to 0700. Existing contents are thereby protected by that directory boundary; new metadata and content files use 0600.

## Security and authority boundaries

### R01 — High: vendored Bash documentation lookup permits shell injection

**Locations:** `vendor/bash-language-server/out/util/sh.js:23–31,65–80`; `vendor/bash-language-server/out/server.js:449–458`.

Completion resolution passes a client-supplied label to documentation lookup. Only literal spaces are rejected before interpolation into `help … | col -bx` or `man … | col -bx`, executed through a shell. Shell metacharacters, tabs and substitutions remain meaningful.

**Impact/prerequisite:** a client-controlled executable completion label can execute commands with LSP privileges. Arbitrary document text automatically executing on hover was **not** established; hover has additional checks.

**Fix:** use literal argument arrays; for shell builtins use a constant script with positional parameters. Validate resolve metadata rather than trusting client-representable types.

**Acceptance:** in an isolated spawn-observer harness, resolve metacharacter-bearing labels and prove no extra command executes. Do not emit attack payloads into a real interactive shell.

### R02 — High: terminal hyperlink metadata permits control-sequence injection

**Locations:** `products/tui/src/renderer/markdown-inline.ts:49–56`; `products/tui/src/renderer/markdown.ts:282–288`; `products/tui/src/renderer/diff.ts:187–190`.

Markdown destinations reach `Cell.link` and are interpolated into OSC 8 output without the visible-text sanitizer protecting that metadata channel. A terminator followed by another control sequence can introduce clipboard/title/cursor controls without a click.

**Fix:** reject controls/terminators and unsupported schemes when creating links and at final emission.

**Acceptance:** capture bytes for hostile Markdown through tokenizer, cells, buffer and diff engine; assert no extra OSC/control sequence. Preserve valid supported URLs. Existing ANSI/bead text tests do not cover this channel.

### R03 — High: protocol-relative transport paths can disclose bearer tokens cross-origin

**Locations:** `packages/engine/transport-http/src/paths.ts:111–119`; `http-core.ts:355–358,393–394`; `sse.ts:14–20` in the same package.

Origin checking is selected for lowercase absolute HTTP(S) strings, while `//other-host/path` reaches URL resolution and can receive the daemon token.

**Prerequisite:** an application passes an externally influenced path into the public authenticated JSON/SSE helpers; this is not an unauthenticated daemon exploit.

**Fix:** resolve first and compare the resulting origin before credential attachment across JSON/SSE/contract paths.

**Acceptance:** protocol-relative, backslash authority and mixed-case absolute inputs cannot fetch cross-origin with credentials; normal relative/same-origin requests work.

### R04 — High: secondary HTTP listener ignores shared-token revocation

**Locations:** `packages/engine/sdk/src/platform/daemon/http-listener.ts:504–508`; `security/http-auth.ts:143–151`; `products/daemon/src/runtime/daemon-host.ts:183–190`.

The secondary listener supplies the shared token and user auth but omits the live pairing-token owner. The common authenticator therefore cannot consult persisted legacy revocation. A revoked token can continue authenticating there; paired replacements also lack the same authentication route as the primary listener.

**Fix:** share live pairing authentication/revocation authority across listeners.

**Acceptance:** enable both listeners, revoke the legacy token, and prove both reject it while an active paired replacement succeeds where intended. Existing parity tests cover token validity, not this migration.

### R05 — High, deployment-dependent: cookie-authenticated WebSocket upgrades omit Origin checks

**Locations:** `packages/engine/sdk/src/platform/daemon/control-plane.ts:449–493`; `daemon/facade.ts:652–657`.

Upgrade authentication occurs before HTTP routing and does not check browser Origin. A hostile same-site sibling origin can carry an eligible session cookie; SameSite=Lax is not a sibling-origin boundary.

**Impact:** a page in that topology can access authenticated events/methods with the victim's authority. Arbitrary unrelated websites bypassing SameSite was not established.

**Fix:** enforce canonical/explicitly allowed browser origins before upgrade, while supporting origin-less bearer-authenticated native clients by explicit policy.

**Acceptance:** a valid cookie plus disallowed sibling Origin is rejected; allowed browser and native cases work; revocation still works.

### R06 — High: Teams reply metadata controls a bearer-credential destination

**Locations:** `packages/engine/sdk/src/platform/adapters/msteams/index.ts:90–91,141–145`; `channels/delivery/strategies-enterprise.ts:36–40,57–63`; `channels/delivery/shared.ts:19–29`.

Inbound `serviceUrl` is retained and preferred for replies. Delivery sends a separately minted Bot Framework bearer token without a destination authority/scheme check at the inspected boundary.

**Prerequisite:** an authenticated ingress bridge caller can control activity metadata. Intended bridge trust and Connector URL requirements need confirmation.

**Fix:** validate against trusted Connector authorities or a configured bridge origin; prohibit cleartext token delivery.

**Acceptance:** malicious/untrusted service URLs are rejected before token transmission; legitimate regional Connector endpoints remain supported.

### R07 — High: incomplete provenance can produce a clean outward-effect decision

**Locations:** `packages/engine/sdk/src/platform/security/untrusted-content.ts:265–276,372–375,495–503`; `security/content-taint.ts:211–212`.

Missing-content ingests, truncation and source eviction are not retained as evidence gaps. If any benign retained text exists, the derivation path can check only that subset and allow an action derived from unavailable material. Whitespace-only retained sources generate no comparison pairs.

**Caller evidence:** inspected email send guards and browser outward-effect guards consume this decision. Other confirmation/owner controls remain relevant; this is specifically a provenance/derivation guard defect.

**Fix:** track missing/truncated/evicted exposure explicitly and require the appropriate owner approval when evaluation is incomplete.

**Acceptance:** missing source plus benign source, whitespace-only source, truncated tail and evicted-source cases cannot be treated as complete clean evidence. Existing contentless-only tests are insufficient.

## Durability, deletion and execution accounting

### R08 — High: transcript recovery rotates the journal after snapshot persistence fails

**Locations:** `packages/engine/sdk/src/platform/runtime/transcript-journal-replay.ts:128–135`; `runtime/transcript-journal.ts:252–257`; caller `products/tui/src/core/session-resume-core.ts:125–137`.

A snapshot exception is swallowed and journal rotation still proceeds. Recovered turns exist only in memory, so another crash can permanently lose them. Corrupt-tail quarantine also needs a replayable-prefix policy until publication succeeds.

**Fix:** retire records only after confirmed durable snapshot publication; preserve replayable data on failure.

**Acceptance:** fail persistence, restart twice and recover the same turns; interrupt corrupt-tail recovery before publication and recover its valid prefix.

### R09 — High: memory-to-knowledge sync retains deleted or contradicted content

**Locations:** `packages/engine/sdk/src/platform/knowledge/memory-sync.ts:11–15,38–64`; callers in `knowledge/service.ts`; retrieval in `knowledge/public-retrieval.ts:225–229`.

Sync filters/upserts current memories without reconciling existing producer-owned mirrors. Removed/contradicted text can remain active; removed tags and session provenance leave obsolete edges.

**Fix:** reconcile producer-owned nodes/edges against canonical memory without removing unrelated knowledge.

**Acceptance:** sync, delete/contradict/remove relationships, sync and reopen; listings and retrieval no longer expose stale mirrors/edges. Initial-mirroring tests do not establish this.

### R10 — High: knowledge-space deletion retains revisions and enrichment state

**Locations:** `packages/engine/sdk/src/platform/knowledge/store-space-delete.ts:73–83`; `knowledge/store.ts:1289–1310,855–856`; schema `knowledge/store-schema.ts:239–269`.

Space deletion omits node revisions and semantic enrichment state; no inspected cascade or later cleanup compensates. Historical titles, summaries, aliases and metadata remain persisted and revisions remain addressable by node ID.

**Fix:** delete dependent records/maps transactionally by selected node/source IDs, matching individual deletion semantics.

**Acceptance:** seed revisions and enrichment, delete space, inspect live APIs and reopened database for retained data.

### R11 — High: automation history pruning removes running jobs

**Locations:** `packages/engine/sdk/src/platform/automation/manager-runtime.ts:871–914`; `manager-runtime-execution.ts:218–223`; `manager-runtime-reconcile.ts:57–58`.

Terminal history quota is applied to all runs. Valid configuration permits history limit 1 and multiple concurrent runs. Starting another run can prune an active record, which then disappears from capacity accounting and reconciliation while its agent continues.

**Fix:** preserve every nonterminal run independently of terminal history retention.

**Acceptance:** history limit 1/concurrency 2, two unresolved runs of one job: both remain tracked and a third is rejected; completion/reconciliation still functions.

### R12 — High: concurrent note transactions silently lose successful writes

**Locations:** `products/agent/src/agent/note-registry.ts:184–206`; `products/agent/src/utils/store-file.ts:46–49,71–77`.

Cross-process read–modify–write uses atomic replacement but no transaction serialization. Two successful creations based on the same snapshot overwrite one another. Existing concurrent-writer tests tolerate partial survival rather than requiring all successful notes.

**Fix:** lock the entire transaction across processes or use transactional storage.

**Acceptance:** all 80 successful unique creations in the four-writer scenario survive, with intact bodies, across repeated runs/reopen.

## Authentication, approval and lifecycle correctness

### R13 — High: relay handoff replays after identity-driven application remount

**Locations:** `products/webui/src/hooks/useRelayPairingHandoff.ts:40–50,59–73`; `lib/relay-pairing.ts:150–153`; `components/auth/IdentityBoundary.tsx:8–22`.

Captured relay code persists at module scope, but consumption is component-local. Pairing storage invalidates lifetime; the identity boundary remounts App; the new hook consumes the same code again and invalidates again.

**Fix:** consumption must survive keyed remounts and happen before invalidation; avoid invalidation for unchanged pairing.

**Acceptance:** mount the hook inside the real IdentityBoundary with a valid fragment; storage/lifetime changes happen once and mounting settles. Existing StrictMode/rerender tests lack that composition.

### R14 — Medium: stale auth validation clears newer credentials

**Location:** `products/webui/src/lib/goodvibes.ts:2875–2883`.

Token A validation can fail after B is installed, then unconditionally clear B in its catch path.

**Fix:** generation-bound ownership of credential cleanup, including A→B→A, rather than token-string equality alone.

**Acceptance:** defer A, validate B, reject A; B remains authenticated. Include cross-tab replacement. Existing single-token tests and mocked handoff tests do not cover the real race.

### R15 — Medium: owner cancellation cannot interrupt stalled artifact acquisition

**Locations:** `packages/engine/sdk/src/platform/artifacts/store.ts:361–366,453–461,669–672`; caller `knowledge/ingest-inputs.ts:82–86`.

Ownership checks prevent late publication when execution resumes, but pending producer reads do not race owner abort, and remote acquisition does not receive that signal. A cancelled operation can retain a spool, reader and resources indefinitely.

**Fix:** propagate cancellation, wake pending reads/backpressure, cancel owned producers and close/remove the spool.

**Acceptance:** abort a never-yielding web stream/iterator and stalled acquisition; reject promptly and clean up. Writer-failure/already-aborted tests are different cases.

### R16 — Medium: overlapping broker approvals are not advanced to the next card

**Locations:** `products/agent/src/permissions/broker-approval.ts:76–86`; `src/shell/approvals-binding.ts:48–65`.

B's deferred callback returns while A is visible, without queueing B. Resolving A clears the card without rescanning waiting approvals.

**Impact:** operations remain blocked without automatic presentation; B is still discoverable in the separate approvals list.

**Fix/acceptance:** queue/rescan active asks; publish A/B, resolve A and automatically present B, skipping stale/resolved asks and preserving local-card deduplication.

### R17 — Medium: approval debounce swallows emergency Ctrl+C

**Locations:** `products/tui/src/shell/blocking-input.ts:87–95,125–130`; `src/main.ts:860–866`.

The first 350 ms suppression returns before the hard-abort handler.

**Fix/acceptance:** handle Ctrl+C before debounce for plain, hunk and exec-answer prompts; at prompt-open time deny/abort exactly once while ordinary type-ahead remains suppressed.

### R18 — Medium: voice transcription overwrites newer drafts and publishes after release

**Locations:** `products/tui/src/audio/voice-input-session.ts:104–117,175–179`; `src/shell/voice-capture-shell.ts:57–60`; `src/audio/voice-capture-wiring.ts:115`.

Pending transcription unconditionally writes the draft even after edits/release. Cleanup also discards the release promise.

**Fix:** generation/lifetime and draft-revision fences; non-destructive insertion policy; await observable teardown.

**Acceptance:** defer transcription, edit/release/replace session, resolve it: no stale draft write/render/notification; cleanup errors are handled. Recording-only release tests do not cover transcription.

### R19 — Medium: MCP reload consumes changes while another reload is running

**Locations:** `products/tui/src/mcp/runtime-reload.ts:50–71`; wiring `src/runtime/bootstrap.ts:630–644`.

The observed signature advances before a busy reload returns early. The newer change will not retrigger. Failures consume signatures too; stop only clears the interval and does not fence pending callbacks.

**Fix:** separate observed/applied generations, queue dirty work, bounded retries and retirement fences.

**Acceptance:** hold A reload, edit B, tick, finish A: B applies without a third edit; failed loads retry appropriately and stop blocks late callbacks.

### R20 — Medium: calendar token-exchange failure launches unrelated device-code flow

**Location:** `products/agent/src/agent/calendar/calendar-oauth-service.ts:265–288`.

The startup fallback catch also catches `completeConnectAuthCode` rejection after a real browser callback, hiding the token-stage error and starting device authentication.

**Fix/acceptance:** fallback only for qualifying listener/startup failures; inject token-exchange refusal and report stage `token` without beginning another flow.

### R21 — Medium: late async summary completion defeats cache limits

**Location:** `products/agent/src/renderer/lane-graph/semantic-memo.ts:52–67`.

Completion reinserts evicted pending entries without an identity check/eviction. Keys retain full diffs.

**Fix/acceptance:** commit only owned pending entries and enforce limits at every insertion; settle more than 200 distinct pending computations and keep the bound.

### R22 — Medium: successful delivery is repeated when reply-target persistence fails

**Locations:** `packages/engine/sdk/src/platform/automation/delivery-manager.ts:227–244`; `channels/route-manager.ts:284–300`.

External send and local reply-target save share one retry boundary. A save failure retries an already delivered message or triggers fallback with an incorrect failure status.

**Fix/acceptance:** separate send commit from bookkeeping retry; successful send plus failed route save retains sent ID and causes no repeat/fallback.

### R23 — Medium: ntfy deduplication suppresses retries after failed delivery

**Locations:** `packages/engine/sdk/src/platform/adapters/ntfy/index.ts:73–103,157–162,213–227`; `adapters/inbound-dedup.ts:59–82`; `channels/provider-runtime.ts:416–421`.

Claims survive exceptions and unsuccessful responses. Retry receives a successful duplicate acknowledgement for work never completed during the default ten-minute window. Subscription handling also treats resolved error Responses as success.

**Fix:** explicit in-flight/completed ownership and delivery commit point; release retryable pre-delivery failures and inspect status upstream.

**Acceptance:** fail remote chat/terminal routing, recover and redeliver same ID; process once successfully without concurrent duplication.

### R24 — Medium: phone pairing network failure leaves an unrecoverable busy screen

**Locations:** `products/webui/src/lib/device-node/phone-node-client.ts:261–275,288–317,332–353`; `views/phone/PhoneNodeView.tsx:87–102`.

Rejected fetch leaves `pairing`; view discards promise rejection and has no action for that state. Null successful JSON can also be dereferenced without guarding the parsed object. Verification failures lack useful recovery handling.

**Fix/acceptance:** publish retryable error states with lifetime fencing and handle event promises; reject transport/malformed response then retry successfully; no stale update after stop/unpair.

### R25 — Medium: active-session persistence clears storage before restoring it

**Locations:** `products/webui/src/App.tsx:241–252`; `lib/companion-chat.ts:154–163`.

Initial persistence of an empty URL-derived selection runs before the restoration effect and removes the saved value.

**Fix/acceptance:** initialize from storage before persistence or gate persistence until restoration; saved non-first session restores, explicit URL wins and absent saved session falls back.

### R26 — Medium: Work queries lack advertised periodic fallback after stream failure

**Locations:** `products/webui/src/hooks/useRealtimeInvalidation.ts:93–94`; `hooks/useSessionRealtime.ts:99–101`; `views/work/useWorkData.ts:72–95`; `components/auth/IdentityBoundary.tsx:9–10`.

Session/task queries lack polling while the banner promises periodic recovery and focus refetch is disabled.

**Fix/acceptance:** implement bounded fallback polling/reconnection or correct the contract; after terminating streams, external changes appear without manual refresh and polling stops appropriately.

### R27 — Medium: knowledge events invalidate only part of mounted knowledge state

**Locations:** `products/webui/src/hooks/useRealtimeInvalidation.ts:54`; `views/KnowledgeView.tsx:168–182`; `views/library/library-data.ts:41–45`; `lib/queries.ts:81–93`.

Nodes, issues, projections, map and candidates have separate nonpolling keys not invalidated by the handler. Local broad invalidation does not cover background/other-surface changes.

**Fix/acceptance:** invalidate all affected knowledge keys; external ingest/consolidation updates status, contents and candidate counts consistently.

### R28 — Medium: unknown-user login skips password hashing

**Location:** `packages/engine/sdk/src/platform/security/user-auth.ts:438–443`; HTTP callers in `daemon/http/router.ts:816–832` and `daemon/http-listener.ts:630–656`.

Short-circuiting avoids scrypt for nonexistent users, unlike existing accounts. Rate limits constrain but do not eliminate timing enumeration.

**Fix/acceptance:** always verify a real or comparable fixed dummy hash before combining existence; assert hashing work in both branches, not merely identical error responses.

### R29 — Medium, exported-helper exposure unestablished: OAuth errors reflect HTML

**Location:** `packages/engine/sdk/src/platform/config/oauth-local-listener.ts:28–29,90–96`.

Unauthenticated callback error text is interpolated into HTML before state validation. The helper is publicly exported; no direct production consumer was established. Default loopback/ephemeral-port scope limits exposure.

**Fix/acceptance:** escape dynamic text or use fixed pages; validate state before provider error handling; markup input is inert text with restrictive response policy.

### R30 — Medium, exported-helper exposure unestablished: invalid callbacks cancel OAuth

**Location:** `packages/engine/sdk/src/platform/config/oauth-local-listener.ts:92–113`.

An unbound error or invalid/missing state rejects and closes the legitimate pending flow.

**Fix/acceptance:** reject invalid requests without settling the owner operation; a later valid callback still completes. Only bound errors, owner cancellation or timeout settle it.

### R31 — Medium: sandbox status overstates local isolation

**Locations:** `packages/engine/sdk/src/platform/runtime/sandbox/manager.ts:46–59,129–165,197–209`; `backend.ts:84–91`; `session-registry.ts:61–70`.

OS availability/host printf are presented alongside secure/VM boundary claims although the local backend executes host processes.

**Qualification:** REPL explicitly refuses non-isolating execution; this is misleading capability reporting, **not** a demonstrated REPL escape.

**Fix/acceptance:** distinguish host execution from isolation; local backend reports isolation unavailable and probes describe only what they test.

## SDK, transport and provider correctness

### R32 — Medium: control-plane input validation under-enforces published schemas

**Location:** `packages/engine/sdk/src/platform/control-plane/invoke-input-validation.ts:103–123`; example `method-catalog-browser-judgment.ts:11,25,28–33`.

Integer is treated as number, permitting fractions/nonfinite in-process values; numeric bounds, string constraints and array cardinality are not fully enforced.

**Qualification:** downstream guards may reject invalid inputs; no resulting authorization bypass was established.

**Fix/acceptance:** implement supported constraints or a maintained compatible validator; test fractions, infinities, ranges, patterns and cardinality through real invocation.

### R33 — Medium: 204/205 success fails when a synthetic Response gets a body

**Location:** `packages/engine/transport-http/src/http-core.ts:443–458`.

Empty JSON becomes null and is stringified into a non-null body on a null-body status, which standards-compliant Fetch runtimes reject.

**Fix/acceptance:** preserve null bodies/avoid unnecessary synthetic responses; real 204/205 mutations succeed with and without middleware in browser/Worker-compatible runtime.

### R34 — Medium: browser/web SDK factories drop supported options

**Locations:** `packages/engine/sdk/src/browser.ts:21–25,64–95`; `client.ts:167,193,207,414–456`; `web.ts:25–26`.

Manual option reconstruction omits middleware, observer and autoRefresh inherited by the public options type.

**Fix/acceptance:** forward inherited options before platform overrides; verify custom headers/events and refresh-disable/callback through both factories.

### R35 — Medium: RN/Expo realtime loses merged reconnect defaults

**Locations:** `packages/engine/sdk/src/react-native.ts:92–133`; `packages/engine/transport-realtime/src/runtime-events.ts:325–327`; SDK `expo.ts:17–18`.

Replacement realtime methods use original options, not the merged reconnect policy; absent policy becomes disabled.

**Fix/acceptance:** resolve once and use consistently; simulate disconnect for default RN/Expo runtime and WebSocket feeds, plus explicit disabled policy.

### R36 — Medium: deleted pagination cursor skips equal-timestamp records

**Location:** `packages/engine/daemon-sdk/src/pagination.ts:150–160`.

Recovery compares only strict timestamps, ignoring unseen peers sharing the deleted cursor timestamp.

**Fix/acceptance:** document/use a total tuple order and matching recovery comparator; page through equal-timestamp records after deleting cursor in both directions without omission/duplication.

### R37 — Medium: Worker enqueue paths ignore configured body limit

**Locations:** `packages/engine/sdk/src/workers.ts:74,96,175,250–267`.

optionalJson uses its default instead of maxRequestBodyBytes for tick/jobs enqueue, unlike direct proxy requests.

**Fix/acceptance:** pass validated finite positive limits consistently; below/above configured limit behave correctly on both enqueue endpoints.

### R38 — Medium: relay fetch corrupts binary request bodies

**Locations:** `packages/engine/transport-realtime/src/relay-transport.ts:402–407`; `packages/engine/transport-core/src/relay/tunnel.ts:13–15,94–99`.

Body text decoding followed by UTF-8 encoding changes invalid UTF-8 bytes despite binary-capable framing.

**Fix/acceptance:** preserve ArrayBuffer bytes; round-trip null/high-byte/malformed UTF-8 payloads exactly while retaining cancellation checks.

### R39 — Medium: telephony delivery sends secret references rather than credentials

**Locations:** `packages/engine/sdk/src/platform/channels/delivery/strategies-bridge.ts:208–212,233–259`; `config/secret-bearing-config-keys.ts:97–100`.

Bridge/Twilio fallback reads raw config goodvibes secret-reference strings instead of using the adjacent strategies' resolver.

**Fix/acceptance:** resolve selected credentials through the shared helper; reference-only config produces actual intended auth, with no raw secret logged.

### R40 — High: cascade automatically accepts confirmation-required judgments

**Locations:** `packages/judgment/src/compounds/cascade.ts:58–60`; `patterns/judge.ts:99–106`; `readings/bands.ts:53–57`.

Pass verdict alone yields accepted=true despite outcome=confirm, including critical stakes.

**Fix/acceptance:** automatic acceptance requires pass and act; preserve confirmation explicitly. Test pass/confirm and critical-band cases; examine downstream consumers of accepted.

### R41 — Medium: function-call question-key collisions substitute evidence

**Locations:** `packages/judgment/src/patterns/call.ts:82–85,143–145,179–199`.

Unrestricted function/argument names flatten ambiguously; Object.fromEntries keeps the last duplicate. Examples include a.b/c vs a/b.c, optional x vs x?, and set x vs x[0].

**Fix/acceptance:** collision-free IDs plus explicit metadata mapping, or upfront deterministic rejection; verify all collision classes and answer attribution. Fan-out separately rejects ambiguous separators.

### R42 — Medium: multi-round selection drops unresolved winner evidence

**Location:** `packages/judgment/src/patterns/select.ts:107–120`.

Groups with a picked candidate advance regardless of outcome; unresolved outcomes are preserved only for NONE picks. With over 254 candidates, a final confident choice can upgrade a winner whose group required confirmation/escalation.

**Fix/acceptance:** propagate the selected candidate's unresolved evidence across stages; test multi-round winning confirm/escalate paths.

### R43 — Medium: leap-day inference throws or rejects a valid future date

**Location:** `packages/judgment/src/patterns/dates.ts:118–145,200`.

An inferred next-year February 29 can return null behind a non-null assertion; current-year validation can also reject before considering an upcoming leap year.

**Fix/acceptance:** explicit valid-date search/policy without non-null assertion; cover today 2024-04-01 and 2023-12-01 with unstated-year February 29.

### R44 — Medium: generated feature column names collide

**Location:** `packages/judgment/src/compounds/features.ts:25–27,46,53`.

Score spread risk_sd conflicts with a distinct question of that name; choice encodings have similar namespace risk. Map creation silently drops a feature while encodeColumns retains duplicates.

**Fix/acceptance:** unambiguous column identity/rejection; collision fixtures preserve every feature consistently across both APIs.

### R45 — Medium: remote process output is unbounded before truncation

**Locations:** `packages/engine/sdk/src/platform/runtime/remote/host/backends/process-runner.ts:65–79`; `host/dispatcher.ts:172–182`.

All stdout/stderr is accumulated before the 4096-character preview limit, affecting local/Docker/SSH/cloud terminal backends.

**Fix/acceptance:** incremental bounded capture/digest with explicit overflow policy; high-volume authorized commands keep bounded memory and complete/cancel safely.

### R46 — Medium: native Ollama/LM Studio paths omit configured auth and headers

**Locations:** `packages/engine/sdk/src/platform/providers/ollama.ts:70–79,108–120,211–219`; `lm-studio.ts:66–74,228–236`.

Native chat/embedding paths omit accepted API key/defaultHeaders that compatibility paths use.

**Fix/acceptance:** consistent endpoint authentication/custom headers; fake authenticated server verifies native initial chat, embeddings and tool/compat turns without unwanted fallback.

### R47 — Medium: Codex reports incomplete/truncated streams as complete

**Location:** `packages/engine/sdk/src/platform/providers/openai-codex.ts:273,360–438`.

Status defaults to completed, incomplete events are not handled and EOF does not require a terminal event.

**Fix/acceptance:** explicit terminal-state machine; EOF after deltas and response.incomplete cannot become successful completion; failed/completed cases retain correct usage/tool semantics.

### R48 — Medium: Gemini cache replacement invalidates concurrent users

**Location:** `packages/engine/sdk/src/platform/providers/gemini.ts:153–158,219–245,273–280,313–317`.

A shared instance deletes prior cached content after another prompt arrives without accounting for requests using it.

**Fix/acceptance:** lease/key resources or defer deletion; interleave A/B prompt generation and prove neither loses its active resource.

### R49 — Medium, API-shape check required: Gemini embedding dimensionality envelope

**Location:** `packages/engine/sdk/src/platform/providers/gemini.ts:506–525`.

Reviewer reports direct REST embedContent serializes outputDimensionality under config instead of top-level.

**Status:** source observation plus provider-contract claim; no live request or independent current API-spec verification was performed during consolidation.

**Fix/acceptance:** confirm the supported endpoint schema, serialize accordingly, and assert requested/returned vector length using a schema fixture and optional approved integration test.

### R50 — Medium: Copilot cached session is not bound to its source credential

**Location:** `packages/engine/sdk/src/platform/providers/github-copilot.ts:49–53,156–180,200–205`.

An unexpired cached token is reused whenever some GitHub credential exists, without binding to the credential/account that produced it.

**Fix/acceptance:** non-secret source/account fingerprint and invalidation; switch A→B and remove/replace credential without reusing A's session.

### R51 — Medium: SSH credential rotation under an unchanged reference is ignored

**Location:** `packages/engine/sdk/src/platform/runtime/remote/host/backends/ssh.ts:36–53,90–111`.

Slots retain a resolved key keyed by reference text rather than current secret version; old keys/multiplexed connections can persist after replacement/deletion.

**Fix/acceptance:** versioned credential leases/change invalidation; rotate/delete same reference and prove later dispatch retires old key/socket authorization.

### R52 — Medium: Discord signed commands lack freshness and replay checks

**Locations:** `packages/engine/sdk/src/platform/integrations/discord.ts:245–264`; `adapters/discord/index.ts:16–39,109–125`.

Signature authenticates timestamp+body but age/interaction-ID replay is not checked before work submission. Expired response tokens do not undo prior submission.

**Fix/acceptance:** freshness window plus failure-aware interaction claims; replay signed command and stale timestamp without repeated agent submission.

## Build, release, installation and local privacy

### R53 — Medium: empty/malformed checksum manifests verify successfully

**Locations:** `packages/engine/toolchain/src/lib/sha256sums.ts:59–81`; `src/bin/sha256sums.ts:29–41`.

Parser skips malformed lines; empty resulting map returns success and CLI claims all assets verified.

**Fix/acceptance:** fail malformed nonblank/empty/duplicate records; where completeness matters require expected assets. Empty, damaged and mixed valid/invalid manifests fail without false assurance.

### R54 — Medium: installer rollback omits pre-publication metadata mutations

**Location:** `scripts/install.ts:172–183,245–257`.

Ownership/environment mutation precedes publication while restoration is gated on published. Adopting preserved data and failing release switching can leave metadata pointed at the failed prefix.

**Status:** narrower pre-publication fault window; ordinary post-publication rollback was traced and is not broadly broken. Intentional preservation of new user data must be distinguished from stale ownership.

**Fix/acceptance:** independently snapshot/restore each pre-existing metadata mutation; inject failure before publication during adoption and compare owner/environment content/existence.

### R55 — Medium: successful service stop followed by query failure bypasses restart

**Locations:** `scripts/install.ts:170,262`; `scripts/installation.ts:126–130`.

stopped becomes true only after stopService returns, but the helper can stop then fail its state query. Recovery sees false and does not restore prior running state.

**Fix/acceptance:** record attempted stop and reconcile actual/prior state safely; successful stop plus failed query restores the prior running installation. Uninstall stop-refusal tests cover a different case.

### R56 — Medium, conditional reuse: local setup action resolves from caller checkout

**Locations:** `.github/workflows/reusable-npm-publish.yml:107–112`; `reusable-binary-matrix.yml:83–88`; `reusable-release-verify.yml:135`.

Ordinary checkout in cross-repository reuse selects caller files; ./.github/actions/setup may be absent/different rather than the reusable-workflow provider's pinned action.

**Fix/acceptance:** immutable external action reference or explicitly separate provider checkout; minimal external caller without local action works. Same-repository current usage is not inherently broken.

### R57 — Low: judgment stale build outputs are excluded from orphan cleanup

**Location:** `packages/engine/scripts/build.ts:33–35,93–96`; `packages/engine/sdk/tsconfig.json:28–31`.

Judgment is built transitively, but sibling packages/judgment/dist is outside the engine child-directory prune enumeration.

**Fix/acceptance:** derive output roots from project graph/include judgment; build temporary module, delete source, rebuild and remove stale JS/declarations from staged output.

### R58 — Medium, retained direct script: Agent release mutates before workspace refusal

**Locations:** `products/agent/scripts/release.ts:278–281,303–311`; `release-prepare.ts:227`; `standalone-release-policy.ts:9–10`.

Parent bumps manifest before child rejects private/workspace standalone release. Earlier clean-tree/branch/evidence checks must pass; not a currently declared package release command.

**Fix/acceptance:** enforce policy before any mutation and compensate failures; direct invocation on workspace refuses with unchanged manifest/worktree.

### R59 — Medium, retained direct script: TUI preparation mutates before obsolete pin checks

**Location:** `products/tui/scripts/release-prepare.ts:173–191`; `products/tui/package.json:76–85`.

Version write/default install precede requirements for obsolete standalone pins not satisfied by current workspace dependencies.

**Fix/acceptance:** early workspace policy/current dependency validation and transactional recovery; refusal happens before version/lock changes. Do not execute install/release casually to reproduce.

### R60 — Medium, consumer-dependent: composite-action install path is shell-interpolated

**Location:** `products/tui/action.yml:60`.

GitHub expression substitution inserts install-dir directly into executable Bash, allowing command substitution if a workflow supplies an untrusted value.

**Fix/acceptance:** pass through env and treat as data; isolated action fixture with shell syntax does not run a marker command and rejects/handles path literally.

### R61 — Low: partial private-IP redaction

 `products/agent/src/verification/live-verifier.ts:168–169` matches only two octets after 10, leaving the final octet of 10.x.y.z in verification artifacts. Use complete IPv4 parsing/alternatives; verify full 10/8, 172.16/12 and 192.168/16 redaction. Verification source is excluded from packaged Agent files.

### R62 — Low, local-permission prerequisite: artifact filesystem modes

 `packages/engine/sdk/src/platform/artifacts/store.ts:284,389,444` creates roots/content/metadata without explicit restrictive modes. Under a traversable parent and umask 022 this can expose content to other users; a private parent prevents that exposure. Create directories 0700/files 0600 and define migration policy. Test under controlled umask/shared parent without modifying host permissions.

## Validation

Focused functional tests were executed through `packages/engine/scripts/test.ts` against the source lanes and fresh emitted SDK artifacts. They exercise hostile shell/link/URL inputs, authentication and revocation, incomplete provenance, journal failure/recovery, knowledge deletion, concurrent note writers and writer death, stalled artifact cancellation, approval sequencing, voice lifetime, MCP retry, relay identity remount, phone pairing recovery, query invalidation, binary relay uploads, pagination deletion, output bounds, provider request shapes, credential rotation, signed webhook replay, judgment outcomes, checksums and installer rollback.

The verification also includes SDK build, the complete TypeScript solution and product source/test/tooling projects, and refreshed public API reports. Tests use local HTTP/relay servers and controlled provider responses; no paid provider calls, real outbound messages, external release publication or external-consumer GitHub workflow run is claimed.

Completed qualification:

- `bun packages/engine/scripts/build.ts`: passed.
- Complete TypeScript solution, integration fixtures, type tests and all product source/test/tooling projects: passed after correcting test fixture types. The corrected engine test project and WebUI projects were rerun successfully.
- `bun run api:extract` and `bun run api:subpath`: regenerated the public surface reports successfully.
- Focused functional suites listed above, reusable-workflow checks, and installer rollback tests: passed.
- `git diff --check`: passed.

Managed deployment uses `./install.sh --workspace /home/buzzkill/Projects/goodvibes-jev`. The installed revision and release directory are recorded in `/home/buzzkill/.local/share/goodvibes-jev/installation.json`; service readiness is checked through authenticated `/api/health` and the installer's HTTP, Jev and TUI smoke checks.


