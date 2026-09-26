# Judgment capabilities against the Jev documentation

`packages/judgment` is meant to offer everything the Jev documentation describes, so that the engine and the products never reach past it to the wire. This note checks that claim capability by capability against `https://docs.typesafe.ai/llms-full.txt` (read in full on 2026-09-26, `jev-1.13.0`). Every row names the module that provides the capability and the proof that exercises it. Nothing in the documentation is missing.

The proof is `bun run proof` in `packages/judgment`. It calibrates every reference decision in `scripts/reference-registry.ts` live against the configured endpoint, runs the compositions that are not decisions of their own, and fails if any decision falls below its accuracy floor or any call is missing from the decision log. `bun run calibrate` runs the same decisions on their own, and `bun test` covers the code-side composition offline.

## The API

| Capability in the docs | Where the package provides it |
|---|---|
| `POST /v1/systemone` with a state and named questions | `createSystemOnePort` in `src/port/transport.ts`, behind the `JudgmentPort` interface in `src/port/types.ts` |
| Noul, Choice and Score questions, with string, object or array instructions and criteria | `noul`, `choice`, `score` builders in `src/port/types.ts`; structured instructions are used by the judge, selector, extraction verifier and existence check |
| Documented limits: up to 255 options, 2 to 10 levels, nonempty questions | `validateQuestions` in `src/port/limits.ts`, applied before every send |
| Context budget: 64k tokens per request, 32k for the state plus the longest question | `validateContextBudget` in `src/port/limits.ts`, a conservative estimate applied before every send |
| Answer shapes, including confidence on Choice and Score and none on Noul | `checkAnswers` in `src/port/answers.ts` refuses any answer that does not match its question |
| Models and aliases; pin a version when thresholds are tuned | `PINNED_MODEL` (`jev-1.13.0`) in `src/port/config.ts`; per-battery `model`; the log records requested and answering model |
| `GET /v1/models` | `createModelCatalog` in `src/port/models.ts` |
| Errors 401, 422, 429, 529 and retries with backoff | the SDK retry policy plus `JudgmentError` kinds in `src/port/errors.ts`; there is no fallback path |
| Another endpoint with the same wire protocol | `TYPESAFE_BASE_URL`; a loopback address selects a local System One model (`endpointKind` in `src/port/config.ts`) |
| Request ids for tracing | carried on every result and error, and stored in the decision log |

## Confidence and routing on uncertainty

| Capability in the docs | Where the package provides it |
|---|---|
| Three paths: act, confirm, escalate | `Outcome` and the band readers in `src/readings` |
| Thresholds scale with the stakes of each action | `YesNoBand` with separate yes and no bounds, `ChoiceBand.perOption`, and the `STAKES_BANDS` table (critical decisions never act alone) |
| Plot accuracy against confidence to choose thresholds | `bun run calibrate` prints confidence bins per decision; `calibrate sweep` re-bands a saved report without new calls |
| Self-consistency: an uncertain band instead of a forced label | the middle of every yes/no band escalates; the calibration report counts how often each band acts |

## The four named patterns

| Pattern | Where |
|---|---|
| Speculative fan-out | every battery asks all its questions in one request; `fanOut` in `src/compounds/fan-out.ts` joins several batteries into one request |
| Confidence-gated routing | the bands above, applied by every pattern |
| Composite scoring | `defineCompositeScore` in `src/compounds/composite.ts` |
| Intent routing | `defineDispatch` in `src/patterns/dispatch.ts` |

## Every cookbook

| Cookbook | Where | Reference decision |
|---|---|---|
| Structure recovery | `defineStructureRecovery`, `renderMarkdown` (`src/patterns/structure*.ts`) | `reference.structure` |
| Autoresearch feature discovery | `encodeColumns` and `featurize` in `src/compounds/features.ts`; the proposal loop needs a text model and belongs to the engine's observe subsystem | proof section `features` |
| Double-checking citations | `defineFidelityChecker` in `src/patterns/fidelity.ts` | `reference.fidelity` |
| Classification using confidence | `defineCoarseningClassifier` in `src/patterns/coarsen.ts` | `reference.industry` |
| Classifying RAG passages | `defineRuleLadder` in `src/patterns/ladder.ts` | `reference.passages` |
| Self-consistency: choices and nouls | the bands and the calibration report | every reference decision |
| Date extraction | `defineDatePartsReader` in `src/patterns/dates.ts` | `reference.dates` |
| Knowledge graph entity alignment | `defineEntityAligner` in `src/patterns/alignment.ts` | `reference.alignment` |
| Function calling | `defineFunctionCaller` in `src/patterns/call.ts` | `reference.trading` |
| Hierarchical classification | `defineHierarchyWalker` in `src/compounds/hierarchy.ts` | `reference.product-taxonomy` |
| Guardrails for LLMs | `definePolicyChecklist` in `src/patterns/policy.ts` | `reference.policy` |
| Parallel questions | batteries and `fanOut` | `reference.ticket-triage`, proof section `fan-out` |
| Pre-parsed value extraction | `defineSelector` in `src/patterns/select.ts` picks among spans code found | `reference.select` |
| Re-ranking | `defineRerank` in `src/patterns/rerank.ts` | `reference.rerank` |
| SDE cascade | `defineExtractionVerifier` in `src/patterns/extraction.ts` and `verifyThenEscalate` in `src/compounds/cascade.ts` | `reference.extraction`, proof section `cascade` |
| Line-by-line search | `defineExistence` in `src/patterns/existence.ts` | `reference.existence` |
| Skill suggestion | `defineRankRecheck` in `src/compounds/rank-recheck.ts` | `reference.skills` |
| Smart home demo: compound split | `splitCompound` in `src/compounds/split.ts` | `reference.multiple-actions`, proof section `compound split` |

## Jev 1.13 limits the package designs around

| Limit | How the package handles it |
|---|---|
| Counting | `defineCounter` asks one yes/no per item and counts in code |
| Math, numbers and dates | arithmetic and date comparison stay in code; dates are read as parts (`dates.ts`) |
| Large state full of irrelevant detail | the context budget check refuses oversized requests; existence and rerank take filtered shortlists |
| Adversarial content | the policy checklist and the passage ladder put the injection rung first; state is data, never instructions |
| Literal reading | fixtures catch it: calibration showed a parameter-named question read "daily" as not stating a bar size, and the reworded question passes |
| Structural invariants | no threshold is carried between a Noul and a Choice; the selector uses both on purpose, the Choice to pick and the Nouls to gate |
| Generation | the package never generates text; the cascade and compound split take generators as ports |

## What the package adds beyond the documentation

Batteries, the decision log and calibration are the project's own infrastructure around the primitives. A battery (`src/batteries/battery.ts`) keeps a decision's questions, bands, fixtures, accuracy floor and pinned model in one definition, as the documentation's advice to keep questions and thresholds in one reviewable place asks. The decision log (`src/log`) records every call, answered or failed, and a call whose log write fails is itself a failure, so no decision acts on an unrecorded reading. Calibration (`src/calibration`) turns each decision's fixtures into a live accuracy check with a floor.
