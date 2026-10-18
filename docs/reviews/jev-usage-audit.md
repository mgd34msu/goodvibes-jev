# Jev usage audit

Baseline revision: `51f97d0a1f345269d78a403b10473e1906e7cc22`. Reviewed working tree: October 18, 2026 (UTC).

The primary assistant reviewed the existing Jev decision/call inventory and the candidates for missing interpretation personally, without delegated agents. The subsequent screenshots exposed a completion gap that the initial placement review missed. That gap and its implemented follow-up are recorded below. Historical measurements and source inventories remain identified by their revision; they are not post-change traffic measurements.

The current checkout registers **318 application/tooling decisions in 50 registries**, plus **22 foundation reference examples** in their separate registry. Four decisions were added after the initial placement revision, `1bf30e87`. Three additional explicit compatibility definitions remain outside automatic registration: field-kind, picker family and PWA platform. Their old automatic callers are removed. The ignored [placement ledger](../../.goodvibes/artifacts/jev-usage/placement-review-ledger.json) records the initial placement revision; the completion additions are enumerated separately below.

The baseline repository defined **339 non-test named Jev decisions**: **317 application and tooling decisions** in **51 registry files**, plus **22 foundation reference examples** in one additional registry. The application decisions occupy 218 source files. Of those decisions, 227 expose fixed question inventories containing 436 questions; the remaining 90 use pattern or custom implementations whose complete question sets are constructed by their readers.

Each named decision is a reusable evaluation definition. Jev returns structured judgments that application code composes into actions: the baseline fixed inventory contains **330 yes/no questions, 85 choice questions and 21 score questions**. One definition can run many times, and one request can carry questions from several definitions.

The historical workspace log is dominated by model metadata interpretation. Model identity matching, context-window classification and chat-model classification account for **327,895 of 358,507 recorded readings, or 91.46%**. This log spans October 14–17 and several source revisions; it is separate from the source inventory of the current revision.

## Runtime changes after the baseline

The source counts and historical measurements below describe the stated baseline revision. Runtime model identity, context-window family, chat-capability and field-name classification now use local data and rules rather than automatic Jev evaluations. Model data comes directly from the models.dev GitHub repository, with base-model inheritance, provider overrides, canonical IDs and model types retained. Unknown entries remain unresolved; context budgets retain their estimate provenance and redaction withholds undeclared fields.

The four replaced readers account for **350,158 historical readings (97.67%)**; the other decisions account for **8,349 (2.33%)**. This measures the captured history, rather than predicting future traffic. The repository-backed cache expires after one hour; normal startup and manual refresh check its freshness.

Detailed inventories are local generated evidence under `.goodvibes/artifacts/jev-usage/`; this report is the maintained review document.

## Categories

Each application decision appears in exactly one purpose category. Baseline/current counts describe registered definitions, not HTTP requests or frequency.

| Category | Baseline | Current | Purpose |
|---|---:|---:|---|
| Knowledge extraction search and answer verification | 57 | 57 | Extract facts and page content; rank sources, facts and evidence; verify answers; align entities; plan and assess repairs. |
| Models providers and request routing | 36 | 32 | Choose model/provider/effort, read request intent/risk and interpret unresolved provider protocols; published metadata stays local. |
| Tool arguments execution search and content analysis | 33 | 31 | Fill or repair parameters, interpret booleans, select tools, inspect code and output, rank content, and summarize pages and edits. |
| Agent planning contracts and work orchestration | 31 | 35 | Shape work and criteria, preserve delegated scope, check fulfillment, synthesis and execution evidence, and route corrections. |
| Security permissions and action admission | 26 | 26 | Read action purpose, risk, side effects and scope; screen untrusted sources; check credentials and protected actions; choose autonomous dispositions. |
| Communication browser voice and integrations | 24 | 29 | Interpret inbound intent and replies, mail style and IMAP errors, browser identity/setup, Google setup, and voice capture failures. |
| Agent harness records and diagnostic interpretation | 17 | 17 | Interpret externally published runtime, personal-ops, memory-provider and remote-publisher records and their schemas. |
| UI labels rendering and command search | 17 | 17 | Rank palette commands, identify code grammar, align settings and provider names, interpret terminal notices; includes library-only status classification. |
| Payments orders and shipping | 13 | 13 | Interpret merchants, cart lines, order and tracking references, shipment dates, recurring charges, shipping tiers and payment replies. |
| People scheduling check ins and inbox triage | 10 | 10 | Read people, addresses, occasion interests and subjects, schedule requests, interruption worth and inbox triage. |
| Privacy redaction and log fields | 8 | 7 | Read opaque credential spans, residual text, owner-profile roles, stored credential candidates and undeclared configuration roles. |
| Developer checks and release tooling | 8 | 8 | Interpret deferred-work markers, identifiers, source anchors, README wording, stale error terminology and binary-load failures. |
| Conversation compaction and retention | 7 | 7 | Choose useful conversation and tool evidence, preserve dependencies and unresolved problems, and verify summary fidelity. |
| Memory and saved personal knowledge | 7 | 7 | Classify memory purpose and usage, align and compare memories, prioritize review, rerank recall and identify persona lines. |
| Settings startup and filesystem interpretation | 6 | 5 | Interpret setting forms/risk, setup commands and approval references; includes a library directory-purpose reader. |
| Catalog code and operational search | 6 | 6 | Search code, hooks, playbooks and ecosystem catalogs; read recommendation fit and trust cautions. |
| Errors failures and retry interpretation | 6 | 6 | Classify ambiguous error wording, choose display payloads, interpret retry waits, and diagnose slow phases or SQLite-vector refusals. |
| Learning and consolidation | 5 | 5 | Grade learning proposals, choose targets, align duplicates, select survivors and verify equivalence. |
| **Application and tooling total** | **317** | **318** | |
| Foundation reference examples | 22 | 22 | Foundation exercises and examples. |
| **All registered definitions** | **339** | **340** | Three additional inactive compatibility definitions remain in source. |

The baseline [complete decision catalog](../../.goodvibes/artifacts/jev-usage/all-decisions.md) lists all 339 names, descriptions, source locations, methods and fixed question counts. [Questions CSV](../../.goodvibes/artifacts/jev-usage/questions.csv) includes every fixed instruction, choice set and band exposed by these definitions. Dynamic questions remain linked to the implementation that constructs them.

## Baseline source counts

| Inventory | Count | Meaning |
|---|---:|---|
| Tracked files inspected | 10,941 | Exact input manifest with hashes, including non-code and binary files. |
| Application, tooling and foundation JS or TS files parsed | 5,544 | Includes source files containing literal NUL bytes; these were parsed rather than omitted as binary. |
| Test and fixture JS or TS files parsed | 4,074 | Separate AST inventory of test helpers and synthetic port setup. |
| Application or tooling named decisions | 317 | Unique names, deduplicated when registries import other registries. |
| Reference example decisions | 22 | Foundation proof and calibration examples. |
| Runtime decision execution expressions | 321 | Decision-method calls, including four captured-method calls, 17 custom attributed requests and five fan-out calls. Caller and implementation layers can describe the same reading. |
| Tooling decision execution expressions | 11 | Seven decision-method calls plus four compound or fan-out examples. |
| Calibration-only expressions embedded in application modules | 14 | Fixture execution in custom decision definitions. |
| Low-level judgment port ask expressions | 68 | Includes forwarding, capture, budgets, lifecycle wrappers, the foundation and the installer health probe. |
| Potential indirect call expressions | 13,211 | Resolved calls to functions that can reach Jev, including error branches, callbacks and logging. These are potential dependencies rather than guaranteed requests. |
| Functions containing those potential dependencies | 6,775 | Static call-graph reachability. |
| Files with direct Jev-related text | 1,749 | 677 runtime, 838 test, 51 tooling, 42 foundation, 101 documentation, 38 metadata and two generated files. |
| Test helper setup or execution expressions | 5,774 | Known Jev helpers in 745 test or fixture files; includes fake ports and local synthetic servers. |

These rows describe different layers and must not be added together to estimate request volume. The call inventories retain the file, line, column, enclosing function, arguments and identified decision names, including retained methods invoked with call or bind. Generic or dynamically selected consumers remain listed with their possible names or parameterized status.

## Historical runtime volume

The read-only snapshot was taken at `2026-10-17T22:40:12.852Z` from `.goodvibes/tui/decisions.sqlite` in this workspace. Its records run from `2026-10-14T04:04:30.421Z` through `2026-10-17T22:09:21.943Z`. It contains 351,132 answered readings and 7,375 failed readings across 40 logged battery labels. These records have no calibration fixture attribution.

| Logged decision | Readings | Share | Mean recorded latency |
|---|---:|---:|---:|
| `routing.model-identity` | 119,704 | 33.39% | 352.0 ms |
| `routing.context-window-family` | 111,925 | 31.22% | 131.4 ms |
| `routing.chat-model` | 96,266 | 26.85% | 125.0 ms |
| `engine.redaction.field-kind` | 22,263 | 6.21% | 151.8 ms |
| `engine.runtime.model-family` | 2,937 | 0.82% | 32.2 ms |
| `engine.tools.project-tooling` | 2,036 | 0.57% | 142.4 ms |
| `routing.same-model-family` | 556 | 0.16% | 121.8 ms |
| `engine.tools.credential-env` | 471 | 0.13% | 116.3 ms |
| `engine.runtime.system-message-presentation` | 395 | 0.11% | 247.0 ms |
| `routing.catalog-provider-access` | 269 | 0.08% | 105.9 ms |

The first four rows account for **97.67%** of logged readings. Recorded usage totals **349,771,332 input tokens** and **48,869,278 output tokens**. These are recorded provider usage values; a monetary amount would require the applicable account pricing. Lineage contains **352,415 transport attempts** across the 358,507 logical records, including pre-dispatch failures with no transport attempt.

Failure kinds are 5,918 invalid requests, 818 rejections, 523 cancellations, 112 invalid responses and four unavailable results. Full per-battery counts, token totals and a separate last-24-hours aggregation are in [observed usage JSON](../../.goodvibes/artifacts/jev-usage/observed-usage.json) and [observed usage CSV](../../.goodvibes/artifacts/jev-usage/observed-usage.csv).

## Consecutive duplicate calls

A consecutive duplicate is an identical evaluation immediately following the same evaluation in the **full, unfiltered call stream**. `A, A` contributes one duplicate; `A, A, A` contributes two; `A, B, A` contributes none. Matching requires the same input-state hash, full canonical questions, requested model and full decision context, including battery/version, pattern and call site. Different calls of any purpose break the run.

In recorded request-start order, the 358,507 calls contain **1,716 consecutive duplicates, or 0.48%**, in 299 runs. The three highest-volume model-metadata decisions together contain just **one** consecutive duplicate.

| Purpose | Calls | Consecutive duplicates | Duplicate runs | Longest run |
|---|---:|---:|---:|---:|
| Model identity | 119,704 | 0 | 0 | 1 |
| Context-window family | 111,925 | 1 | 1 | 2 |
| Chat capability | 96,266 | 0 | 0 | 1 |
| Log-field role | 22,263 | 1,580 | 267 | 66 |
| Project test framework | 170 | 118 | 22 | 8 |
| Failure interpretation | 27 | 8 | 2 | 6 |
| Residual credential check | 57 | 6 | 4 | 3 |
| Project tooling | 2,036 | 3 | 3 | 2 |
| All other purposes | 6,059 | 0 | 0 | 1 |
| **Total** | **358,507** | **1,716** | **299** | **66** |

The longest request-start run asks about the `error` field 66 times without a different call in between, from `2026-10-17T17:01:39.788Z` through `2026-10-17T17:02:32.991Z`. These are separate logged evaluations, rather than transport retries inside one evaluation.

Request-start timestamps have millisecond resolution. The primary ordering uses the log insertion sequence to break timestamp ties; 12 of its matching adjacent pairs touch mixed-call timestamp groups and have ambiguous initiation order. Excluding those matches leaves 1,704 unambiguous adjacent pairs. As a separate concurrency cross-check, completion/log-insertion order yields 1,663 consecutive duplicates and a longest run of 67. The two orders answer different sequence questions and are retained separately in the [consecutive analysis](../../.goodvibes/artifacts/jev-usage/consecutive-duplicates.json) and [run inventory](../../.goodvibes/artifacts/jev-usage/consecutive-runs.csv).

## Recurrence across the whole observation period

This broader comparison includes `A, B, A`. Its repetition rate does not measure consecutive duplicates and is not the basis for the consecutive-call priorities below.

The four highest-volume decisions contain **350,158 evaluations of 6,437 distinct request contents**. Matching groups require the same canonical input-state hash, full canonical questions, requested model and battery version. Changed identity candidate lists are part of the input and therefore count separately. Every matching group also occurs at exactly one call site: these counts do not combine the same wording across different call-site purposes.

| Evaluation purpose | Recorded evaluations | Distinct request contents | Evaluations beyond the first |
|---|---:|---:|---:|
| Model identity | 119,704 | 2,456 | 117,248 |
| Context-window family | 111,925 | 1,959 | 109,966 |
| Chat capability | 96,266 | 1,876 | 94,390 |
| Log-field role | 22,263 | 146 | 22,117 |
| **Total** | **350,158** | **6,437** | **343,721** |

The **98.16% content-repetition rate is not a measured avoidable-work rate**. A fresh evaluation is distinct work when its purpose, facts, policy or authorization lifetime requires a new result. The log retains call-site attribution but does not identify process/session, authority, settings or policy generations, so it cannot establish which earlier results remained valid for reuse. Same-content evaluations also include additional attempts after uncertainty or failure. Across these groups, 339,007 answered evaluations follow another answer to the same request content; an answered request can still produce an inconclusive decision.

The clearest repeated-inconclusive case is the log field named `error`: **14,977 evaluations**, including **14,767 recorded `escalate` outcomes**, 207 failures and three answered entries without recorded readings. No actionable outcome is recorded for that input. The reader evaluates the field name alone, rather than each error's contents. Its current implementation removes inconclusive entries from its cache, permitting subsequent log events to ask the same unresolved question again. This calls for reviewing retry/admission behavior without treating an inconclusive answer as settled or bypassing redaction.

The [repetition analysis](../../.goodvibes/artifacts/jev-usage/repetition-analysis.json) records the comparison method, per-purpose counts, sites, daily counts and top recurring inputs. The [query inventory](../../.goodvibes/artifacts/jev-usage/repeated-queries.csv) contains all 6,437 groups as hashes with counts; raw input states are not retained by the decision log.

## Request multiplication and caching

| Operation | Logical readings on an uncached admitted path | Current control |
|---|---|---|
| Model identity lookup | One selector request per nonempty shortlist; at most eight shortlisted candidates under current identity policy. | In-flight deduplication and memory cache; persistent storage is optional. Six of the seven resolver construction sites omit a persistent path. Catalog, OpenRouter and benchmark resolver lifetimes are tied to source arrays or maps. |
| Unsized model context-window fallback | One request for an unknown provider/model pair. | Reported/catalog facts are tried before semantic fallback; settled results are remembered in the process. |
| Provider listing with unspecified chat capability | One reading per model whose capability was not supplied. | Eight concurrent workers; bounded process memo. Authoritative capabilities avoid this reading. |
| Request routing | Six batteries in one fan-out request. | Tier, intent, difficulty, risk, domain and language share one wire request. |
| Browser command palette | One reading per candidate, up to 64 per search. | 200 ms debounce, four workers per run, cancellation on edited query or changed source; service-wide concurrency is separately bounded. |
| Credential-provider, config-key, card-key or catalog-provider browser matching | One reading per admitted key or candidate, up to the adapter limit of 64. | Host-owned source snapshots, bounded fan-out and cancellation. |
| Code-block language | One reading for an admitted canonical code block. | Bound to session/message content and offsets; cancelled on lifetime changes. |
| Log field classification | One reading for a previously unknown field name within a FieldKindReader lifetime. | A 256-entry instance cache and pending deduplication. Synchronous log output withholds unread values while the reading is pending. |
| Generic rerank | One reading per query/candidate pair. | Pattern-level concurrency; caller memo and input limits vary. |
| Large selector | Requests for chunks of up to 254 candidates, followed by selection among group winners. | Preserves unresolved evidence across rounds. |
| Contract checks | One judgment per check; repeated checks, shaping, coverage and correction steps are separate readings. | Currentness, execution ownership and recorded lineage are checked by native admission. |
| Compaction or security scans | Per-candidate or per-block reads, sometimes followed by dependency or per-line checks. | Their loops and budgets are at the individual reader; one API operation can contain many logical readings. |

A cache hit can make one of these source paths perform zero transport calls. A logical reading can also make multiple transport attempts during retry. Primary-only transient failures stay pending with backoff until completion or cancellation; explicit fallback chains follow the configured finite order.

## Current UI wiring

The daemon registers ten browser judgment purposes: code language, speech seams, configuration key roles, card-material key roles, credential/provider matching, catalog/provider matching, install-platform metadata, command ranking, daemon refusal interpretation and reply-subject prefixes. Browser callers submit the fixed `judgment.battery.run` contract rather than arbitrary System One prompts or endpoint credentials.

**Status badge classification is currently library-only.** The older `webui.status.badge-tone` definition and adapter remain available in source and tests, but the current browser registry does not register that adapter. `StatusBadge` reads the structural status catalog, and unknown statuses render as unclassified. Its battery definition is therefore counted in the catalog without being counted as an active badge-rendering request.

TUI and Agent also reach Jev through shared engine readers. Their renderer, logging and error paths can therefore have a Jev dependency without importing the judgment package. The [indirect consumer inventory](../../.goodvibes/artifacts/jev-usage/indirect-consumers.csv) includes those conditional paths.

## Transport and data flow

Normal runtime composition gives application readers a settings-owned recorded JudgmentPort. The central foundation transport supports two implementations of the same `POST /v1/systemone` request: an SDK client for timed requests and the shared raw-fetch path for untimed requests. The sole direct TypeSafeClient construction is in the foundation client module. The foundation also exposes `GET /v1/models` through its model-catalog API; this is discovery rather than a judgment and has no application consumer at this revision.

Protected-source screening is an explicit separate route. Its owner creates an isolated foundation port at [source-screening/owner.ts](../../packages/engine/sdk/src/platform/security/source-screening/owner.ts), uses a constrained transport for the configured hosted or local destinations, and calls the screening/reference verifiers through that port. It uses the same central System One transport and retry implementation while bypassing the installed runtime port and its normal decision log. Those readings are therefore not represented by the historical TUI-log totals above.

The configured default is `jev-latest` at `https://api.typesafe.ai`; operators can configure compatible targets and explicit fallbacks. The browser uses the authenticated daemon bridge. Tooling and installer probes construct the same foundation transport directly; they do not require a running application composition.

Inputs vary by purpose. They include user requests, proposed actions and arguments, agent output and criteria, code and document excerpts, retrieved facts and evidence, model/provider names, external status records, log field names and protected redaction projections. Jev is therefore part of content analysis as well as metadata handling. Redaction readers withhold locally protected values and ask about opaque span references. Field roles now use the local declared policy. The decision log records questions, answers, readings, usage and a state hash; it does not retain the state text itself.

## Placement findings and disposition

Nine baseline definitions are no longer automatically registered: model identity, context-window family, chat capability, log-field role, picker family, watched-file names, artifact kind, output kind and PWA platform. Six interpretation definitions were added for Google grant/API failures, 2-Step state, app-password state, verification-mail artifacts and TUI command discovery. Agent audit intent reuses its existing selector.

| Finding | Implemented behavior |
|---|---|
| Model metadata and picker grouping | Repository-backed identity, model type, context/output limits and family facts replace automatic classification. Exact endpoint facts precede retained reasoning/output-cap fallbacks. The first five retired purposes represented 353,095 historical readings (98.49%). |
| Test runner at agent spawn and project inspection | Literal runner commands, environment wrappers and bounded script delegation resolve locally. Custom executors and compound shells retain Jev. Complete manifest/run ownership remains checked. No cross-agent reuse is assumed merely because request text repeats. |
| Provider catalog aliases in WebUI | The existing registry aliases are shared through the browser-safe contracts surface. Declared joins, including `openai-subscriber → openai` and `inception → inceptionlabs`, use local data; unrelated catalog providers are not queried for these joins. The semantic endpoint refuses declared-alias requests; custom relationships retain Jev. |
| Generated runtime notices | Exact declared occurrence provenance and producer wire formats supply severity/category locally, including transcript indexing and restored messages. Arbitrary notice text retains Jev. |
| Root-file watching | Watch regular root files locally. No filename-purpose reading or file-content transmission is needed. |
| Artifact kinds | Explicit MIME types and the existing extension registry determine document/data/archive/media kinds. Unknown formats remain files. |
| Output-policy summaries | Report byte/character/line counts and local string/JSON format. Diagnostic kind labeling needs no Jev request. |
| PWA installation instructions | Browser platform tokens and desktop-mode iPad touch metadata resolve locally and work without the daemon. The runtime no longer registers the platform-reading adapter. |
| Google app-password page | Read localized current prerequisites and existing entries with Jev. Missing controls do not establish disabled 2-Step Verification. Help text and organization restrictions are distinct from a current prerequisite. |
| Verification mail | Interpret which offered artifact actually verifies the requested signup/login, rather than returning the first same-domain link or English-labeled number. Ordinary Jev receives opaque references, not token URLs/codes. Complete projected context requires the existing protected-source owner. Domain, expectation, request and cancellation checks remain local; unresolved readings do not consume the expectation. |
| Typed failures and permissions | Home Assistant timeout status comes from the local deadline. Cloudflare migration recovery requires SDK error code `10074`. Read waivers require successful native write/edit tools, rather than a name containing those words. Weak routing-family readings cannot broaden the selection; unsettled negatives cannot establish metered access. |

The unexported watched-config, artifact-kind and output-kind batteries and the empty artifact registry were removed. The remaining explicit compatibility definitions are distinguished from current automatic consumers in the ledger.

Retained mixed cases include custom provider catalog/credential names, unknown provider protocol labels, custom project executors, provider hosting/payment declarations, and unstructured notices. Authentication mode, endpoint address and zero model prices do not establish a provider’s payment/setup class. Published family taxonomy also does not encode routing’s major-generation boundary; that interpretation remains. The exact selected model bypasses its family reading.

Consecutive duplicates still mean adjacent `A, A` in the full stream with identical purpose and evidence; `A, B, A` remains valid. The changes remove unnecessary purposes and factual queries, rather than treating changed owners or different reasons as duplicate work.

## Repository-wide personal review

The initial placement review at `1bf30e87` inventories production JavaScript/TypeScript across engine, Agent, TUI, daemon, WebUI and tooling, with foundation transport/examples identified separately. That manifest contains **5,548 production/foundation JavaScript or TypeScript sources**. Each registered application definition and direct execution/composition/transport expression at that revision has a disposition in the placement ledger. Its direct application/tooling execution inventory contains **319 runtime expressions and 11 tooling expressions**; the separate low-level inventory contains **68 ask/forwarding expressions**. These layers can describe the same request and are not request-volume totals.

The initial review's final literal sweep inventories **5,508 engine/product sources and 1,969 candidates in 729 files**; its starting queue contained 1,977 candidates before the fixes. The additional sweep examined **754 candidates in 412 files**, covering dynamic matches, short words, classifier functions and ranking logic. Candidate listings were reviewed and suspicious readers traced through their callers. Shell/install sources, the generated Python operator client, native audio wrapper, test/calibration paths and transport construction were also checked for their role. File/AST enumeration is an inventory aid, not a claim that every source line was read. Literal search, protocol parsing, explicit policy/thresholds, structural validation and downstream semantic readers were retained where appropriate. The completion investigation below found a missing boundary that these sweeps did not catch.

The current source manifest and final literal sweep are retained with the ignored evidence. Runtime traces remain the historical snapshot above; the audit does not claim a measured post-install request rate.

## Interpretation additions

The initial additions below remain implemented; the app-password and verification-mail additions are detailed above.

| Area | Jev interpretation | Local behavior preserved |
|---|---|---|
| Google grant and API failures | [failure-readings.ts](../../packages/engine/sdk/src/platform/google/failure-readings.ts) batches atomic questions about the reported cause. Unknown, contradictory or weak evidence cannot establish a specific cause. [connection-proof.ts](../../packages/engine/sdk/src/platform/google/connection-proof.ts) carries the structured result instead of interpreting the explanation again. | Exact account comparisons, bare error codes, OAuth `invalid_grant` latching, documented API error reasons and HTTP rate limits stay local. `diagnoseInvalidGrant` now returns a promise; its caller awaits it. |
| Google 2-Step Verification | [browser-elements.ts](../../packages/engine/sdk/src/platform/google/browser-elements.ts) reads the complete observed page text, URL and control labels through the owned browser pipeline. Localized labels, negation, help text and sign-in challenges are distinguished. | Page ownership and cancellation are checked around asynchronous work. This describes setup state and does not authorize changing an account setting. |
| Agent audit requests | [agent-audit-tool.ts](../../products/agent/src/tools/agent-audit-tool.ts) uses the existing protected catalog selector over the four supported read modes when the action is omitted. The complete original request is screened and retained. | Explicit actions and item/artifact IDs bypass interpretation. An empty request still shows readiness. Unknown explicit actions and unresolved intent return an error rather than silently choosing readiness. |
| TUI command discovery | [command-discovery.ts](../../packages/engine/sdk/src/platform/routing/command-discovery.ts) batches all registered commands into a selector request, returning only actionable fitting suggestions. [command-palette.ts](../../products/tui/src/input/command-palette.ts) starts the fallback after a 250 ms typing pause when literal search has no matches. | Literal search and rendering remain synchronous. Query changes and closing cancel work; command metadata, handler changes and retired Jev installations invalidate suggestions. Repeated rendering and an unchanged query reuse the result. The person still selects a command before its normal handler runs. |

The earlier synthetic error “The client account was suspended by the organization administrator.” incorrectly produced a definite `client-mismatch`. It now remains unknown. Testing publishing status alone also no longer proves that a token expired. Original counterexample evidence remains with the ignored local audit artifacts.

Grant diagnosis uses the low-stakes band because the OAuth protocol has already established whether the token is invalid; interpretation only chooses an explanation and offers fresh consent. It never changes token validity or authorizes reauthorization. Page-state observations use the medium-stakes band; actual browser actions and verification retain their separate boundaries.

Verification at `1bf30e87`: **599 engine tests, 153 Agent tests, 142 TUI tests and 52 WebUI tests passed: 946 tests across 62 functionality files**. Tests exercise local facts without a Jev port, real adapter/caller flows, source replacement/cancellation, privacy projections and ambiguous/negated/localized evidence. Live calibration passed the initial 45 assertions across 20 fixtures and the follow-up 14 checks across nine fixtures. Four follow-up readings remained in the confirmation band and therefore do not automatically advance the caller. Earlier failing app-password counterexamples are preserved beside the corrected final calibration results. Three live audit-intent checks exercise the actual adapter; their synthetic source-screening fixture, like the verification adapter fixtures, is not proof of live privacy-screen accuracy. The repository-wide type check, all four product builds, API extraction/surface checks, browser compatibility and `git diff --check` passed at that revision. Raw reports and logs remain in the ignored audit folder.

Confirmed existing interpretation paths include autonomy-intake intent/cadence reading, occasion subject attribution, knowledge relevance/fidelity checks, project tooling ambiguity and unstructured notice presentation. These are retained. The deprecated possessive-name helper, structural tool-result parsers and numeric notification thresholds are not missing-Jev findings.

## Completion enforcement follow-up

Ordinary conversation turns delivered user input directly to the model, then accepted a no-tool final response without checking whether the original request was fulfilled. Standalone agents had the same gap. Contract units already had goal, quality, claim and acceptance checks; these remain in place. The fix adds final-response enforcement to ordinary main turns and standalone agents without delaying initial prompt delivery or duplicating contract-unit checks.

| Battery | Questions | Boundary |
|---|---:|---|
| `engine.core.response-completion` | 5 | Unfinished authorized work, unsupported execution claims, false blockers, unanswered questions and requests for permission already granted. |
| `engine.agents.brief-fidelity` | 2 | Standalone assignment scope and applicable constraints, before any agent in the proposed batch starts. Existing contract planning checks cover contract-backed assignments. |
| `engine.core.delegation-consolidation` | 2 | Relevant missing results and unresolved contradictions, using only agents referenced by the coordinator's own tool results. |
| `engine.core.execution-assurance` | 6 | Applicability and concerns for ineffective fixes, irrelevant verification and weakened success criteria. No coverage target or automatic requirement to add tests. |
| `engine.compaction.retention` version 2 | 3 | Existing substance rubric plus preservation of active obligations and exact execution targets. |

Completion, synthesis and execution checks run concurrently over the same captured evidence; every applicable check must settle before finalization. Rejected drafts return to the provider with a correction in its actual system prompt. The guard preserves original task and execution evidence through in-run compaction. Claims based on earlier turns still receive execution checks even when the current turn runs no tools. Three consecutive correction opportunities are allowed; another rejected final attempt fails visibly. A successful tool round resets that consecutive count. Unavailable, malformed or stale readings never silently approve completion.

The accepted final response is checked again through cleanup and deferred terminal publication. Changing its output, cancelling its owner or retiring the judgment port prevents a successful terminal event. Nested standalone coordinators receive the same delegated-result checks as main. Host code supplies the authoritative task and parent identity on agent-spawn calls.

Compaction cannot trade a lost active requirement or required exact target for a better compression score. Either loss sets retention to zero; uncertainty refuses application. If the final fallback remains below the quality threshold, the manager retains the original conversation and emits failure. This applies to compaction controlled by this runtime, including the candidate-application boundary; external harness compaction is outside its control.

The [vibecheck-jev reference](https://github.com/mgd34msu/vibecheck-jev) informed the completion questions. This implementation uses native engine loops, evidence admission and publication checks rather than copying its stop-hook control flow. It does not inherit a silent pass after retry exhaustion or checker unavailability. No follow-up-intent classifier was added.

Live calibration against `jev-1.13.0` correctly labeled **121/121 fixture questions**. Through the actual guard, all ten unsafe drafts were held; eight of nine valid drafts were released immediately. One complete delegated review was conservatively held because its unfinished-work probability was `0.26`, short of the required confident negative. That unresolved reading was not treated as permission to finish. These fixtures use synthetic execution receipts, not a live repository review. Earlier counterexamples remain beside the [current calibration report](../../.goodvibes/artifacts/jev-usage/task-assurance-calibration.json). This checks observed evidence; it cannot prove an unobserved inspection occurred or guarantee a model judgment is always correct.

Functionality verification for this follow-up: **465 engine tests and 12 daemon tests pass across 32 files**. The tests exercise real main and standalone loops, correction delivery to the next provider request, scope refusal before partial batch effects, parallel checks, exact-output finalization, cancellation and port retirement, and compaction refusal before application. The paired daemon HTTP test executes the real judgment transport against a separate synthetic local endpoint before its hosted turn completes. No coverage-percentage target was used.

The repository-wide type check, final SDK and cross-product incremental type checks, all four product builds, API extraction and subpath surface check, browser compatibility and whitespace checks pass. The guard submits complete textual evidence; private or unsupported evidence is withheld and cannot establish completion. It does not silently truncate evidence to obtain a passing judgment.

## Source paths behind the main findings

- Model repository: [snapshot ingestion](../../packages/engine/sdk/src/platform/providers/model-catalog-repository.ts), [normalization and cache](../../packages/engine/sdk/src/platform/providers/model-catalog-cache.ts), and [shared capability and identity facts](../../packages/engine/sdk/src/platform/providers/model-catalog-facts.ts).
- Local metadata consumers: [identity joins](../../packages/engine/sdk/src/platform/routing/model-identity.ts), [context limits](../../packages/engine/sdk/src/platform/providers/context-window-catalog.ts), [chat filtering](../../packages/engine/sdk/src/platform/providers/live-model-discovery.ts), [failover groups](../../packages/engine/sdk/src/platform/providers/model-catalog-synthetic.ts), and [benchmarks](../../packages/engine/sdk/src/platform/providers/model-benchmarks.ts).
- Browser fan-out: [command reader](../../packages/engine/sdk/src/platform/judgment-browser/batteries/webui-readers.ts), [200 ms palette debounce](../../products/webui/src/components/command/CommandPalette.tsx), and [registered browser purposes](../../packages/engine/sdk/src/platform/judgment-browser/webui-runtime.ts).
- Local field policy: [FieldKindReader](../../packages/engine/sdk/src/platform/utils/field-kind-reading.ts) and [activity logger](../../packages/engine/sdk/src/platform/utils/logger.ts).
- Current status rendering: [StatusBadge](../../products/webui/src/components/StatusBadge.tsx) and its [producer status catalog](../../packages/engine/sdk/src/platform/judgment-browser/batteries/webui-status-catalog.ts).
- Shared transport and logging: [runtime composition](../../packages/engine/sdk/src/platform/runtime/judgment-services.ts), [central transport](../../packages/judgment/src/port/transport.ts), [TypeSafe client construction](../../packages/judgment/src/port/client.ts), [model discovery](../../packages/judgment/src/port/models.ts), and [decision-log record types](../../packages/judgment/src/log/types.ts).

## Current review evidence and baseline inventories

| Artifact | Contents |
|---|---|
| [Initial placement ledger](../../.goodvibes/artifacts/jev-usage/placement-review-ledger.json) | Primary-review dispositions and source hashes at `1bf30e87`, before the completion follow-up. |
| [Initial source inventory](../../.goodvibes/artifacts/jev-usage/current-inventory.json) | Inventory at `1bf30e87`; inactive compatibility definitions are identified separately. |
| [Completion calibration](../../.goodvibes/artifacts/jev-usage/task-assurance-calibration.json) | Live labels and actual-guard outcomes, including the conservatively held valid case. |
| [Final literal sweep](../../.goodvibes/artifacts/jev-usage/final-heuristics.json) and [additional sweep](../../.goodvibes/artifacts/jev-usage/extended-sweep.json) | Complete candidate queues used for personal caller tracing; these are not automatic correctness verdicts. |
| [Initial calibration](../../.goodvibes/artifacts/jev-usage/added-readings-calibration.json), [mail calibration](../../.goodvibes/artifacts/jev-usage/full-audit-calibration.json) and [corrected app-password calibration](../../.goodvibes/artifacts/jev-usage/app-password-calibration-final-2.json) | Live results; the combined first follow-up also retains the original app-password failure rather than overwriting it. |
| [All decisions](../../.goodvibes/artifacts/jev-usage/all-decisions.md) | All 339 named decisions grouped by purpose, with descriptions and source links. |
| [Decisions CSV](../../.goodvibes/artifacts/jev-usage/decisions.csv) and [JSON](../../.goodvibes/artifacts/jev-usage/decisions.json) | Definition metadata, fixed questions, methods, direct calls and symbol/literal references. |
| [Fixed questions](../../.goodvibes/artifacts/jev-usage/questions.csv) | Full instructions, question types, criteria and bands. |
| [Direct decision calls](../../.goodvibes/artifacts/jev-usage/direct-calls.csv) | Runtime, tooling and custom calibration expressions. |
| [Port creation and calibration entrypoints](../../.goodvibes/artifacts/jev-usage/port-and-calibration-entrypoints.csv) | Normal runtime compositions, isolated screening, installer probe, live tooling and synthetic native-product proofs. |
| [Port calls](../../.goodvibes/artifacts/jev-usage/port-calls.csv) | All 68 captured low-level ask expressions, including forwarding layers. |
| [Indirect consumers](../../.goodvibes/artifacts/jev-usage/indirect-consumers.csv) | Every resolved call expression whose target can reach an identified Jev use. |
| [Symbol references](../../.goodvibes/artifacts/jev-usage/named-references.csv) and [literal decision references](../../.goodvibes/artifacts/jev-usage/literal-decision-references.csv) | Imported aliases, generic helpers, registry lookups and named metadata consumers. |
| [Text references](../../.goodvibes/artifacts/jev-usage/all-text-references.csv) | All matching source, test, metadata and documentation locations. |
| [Consecutive analysis](../../.goodvibes/artifacts/jev-usage/consecutive-duplicates.json) and [run inventory](../../.goodvibes/artifacts/jev-usage/consecutive-runs.csv) | Adjacent identical evaluations in the full call stream, with request-start and log-insertion order kept separate. |
| [Repetition analysis](../../.goodvibes/artifacts/jev-usage/repetition-analysis.json) and [query inventory](../../.goodvibes/artifacts/jev-usage/repeated-queries.csv) | Exact-content recurrence within the four highest-volume purposes, with uncertainty and lifetime limitations. |
| [Test helper calls](../../.goodvibes/artifacts/jev-usage/test-helper-calls.csv) and [test source census](../../.goodvibes/artifacts/jev-usage/test-source-census.json) | Separate test and fixture inventory. |
| [Source manifest](../../.goodvibes/artifacts/jev-usage/source-manifest.csv) | Every tracked input and its content hash. |
| [Summary](../../.goodvibes/artifacts/jev-usage/summary.json) and [full compressed inventory](../../.goodvibes/artifacts/jev-usage/full-inventory.json.gz) | Machine-readable counts and complete graph results. |

The inventory uses tracked-source parsing, workspace export resolution, imported symbol aliases, generic decision parameters, dynamic selection tables, callback references and registry introspection. Runtime and tooling sources were parsed semantically; test/fixture files received a separate AST census. Source call-graph reachability includes conditional logging and error paths, while RPC/interface dispatch remains represented at its caller, registered adapter and actual decision reader. A zero count in one layer is not a claim that a declared library feature is unreachable through an external consumer.
