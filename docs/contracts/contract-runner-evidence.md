# Contract runner evidence and compatibility

Jev owns judgments about text meaning and work quality. Code owns structural and
machine facts: IDs, cycles, exact formats, quote positions, counts, status moves,
file existence, exit codes, merge state, bounded queues and store validation.
Neither class may manufacture evidence of success. The
[autonomous decision contract](../design/autonomous-jev-decisions.md) governs new
product semantic execution. Historical confidence bands and owner-reply data must
remain distinguishable from autonomous receipts; they cannot authorize a new
human semantic approval workflow or silently become `act`.

## Completion reports and evidence

Parse only the completion format dictated to the unit: the last fenced JSON
block with `version: 1` and a string `archetype`. Never salvage prose by brace
counting. An absent report is null, makes no claims, and is described as absent.
The plan role decides whether the unit must write, not its self-declared report
archetype. For non-contract phase-runner items, use the engineer/integrate phase
kind. Inspect `filesCreated` and `filesModified` regardless of report archetype.
Preserve the no-claims/no-changes failure for units required to write; changing
the report archetype must not bypass that check.

Corroborate the unit's own baseline-scoped changed paths, including committed,
uncommitted and untracked changes in the item worktree or project root. Whole-tree
`git diff --stat HEAD`, launch residue, sibling units' changes and a commits-only
diff are not equivalent evidence. Phase-runner evidence uses the item worktree's
status or the shared tree with untouched launch residue excluded. Preserve
`changesDetected` rather than claiming only Git diff detection.

Store the parsed completion report as `ContractUnit.lastReport` at every
completion check; resume reads that object instead of reparsing truncated
head/tail output. Deliverable judgment consumes the deliverable unit's complete
final output plus answers of units that repaired it. If no output was recorded,
the input is empty, never a fixed sentence declaring all criteria met. Human
presentation may still use the summary without changing the judged evidence.

The quality state carries completion gates and omitted paths. A statement that
its actual test gate proves must not appear unsupported solely because the judge
was deprived of that gate result. Keep `unshown` separate from `unmet` in stall
routing: absent evidence is not evidence of failure. Cover unit, group and
deliverable targets.

## Criteria, planning and quality interpretation

Keep reading-to-verdict rules beside the bands in the unit-judge and unit-quality
batteries, shared by unit, group and deliverable checks. A yes-leaning problem
reading is unmet regardless of outcome; a met judgment requires no at act under
the relevant historical band. Mid-run nudges apply only to the declared mid-run
quality items read yes at act. Use the shared `saysYesAtAct` predicate for the
writing-role check rather than a divergent inline interpretation.

Plan coverage uses atomic questions: for each unquoted stretch of the original
ask, whether those words request anything; for each quoted stretch, whether the
criteria quoting it demand less than those words. Quote positions are arithmetic
only after the structural check proves every quote belongs to the ask. Unit
narrowing is read per served contract criterion with sibling criteria in state,
not only sibling titles. A yes-leaning problem names the words or requirement.
For the legacy coverage band a no at act or confirm clears a part; a no-leaning
unit-narrowing reading clears because each contract criterion is judged again
at the deliverable check at high stakes. Do not reinterpret these old bands as
autonomous execution receipts.

Checkability no at act or confirm is a planning problem. In legacy topology disposition, a topology-only criterion
is excluded or met by structure only on yes at act. Original-source/native-source
paths do not take this structural topology disposition. The criterion-shape battery
explicitly identifies doing all work alone as topology; a topology-only `solo`
reading at act is satisfied by session-mode single-agent structure. Below those
thresholds, criteria remain subject to evidence checks. A role mismatch requires
a settled act reading; uncertainty is not evidence of a wrong role. Low-stakes
request-shape parallel/attempts yes below act means not requested, as declared by
the battery. Do not silently change these interpretations while extracting docs.

For legacy contracts, when all criteria are excluded or met by structure, there
is no deliverable judge: the pattern needs an actual criterion, and the goal is
planner-authored, not the original user request. For original-source work
with derived acceptance checks, admission requires a judged criterion and
completion refuses zero judged criteria. Native/original-source contracts retain
their own source/admission checks rather than borrowing this legacy bypass. Unread severity uses the middle rank only to order
fix units that touch the same file; it is not reported as a settled reading.

Persist `CriterionReading.severityDecisionId` whether or not severity settles.
Failure conclusions expose their real decision ID, and transport-retry/failed
contract decisions name it. A failure is retried only when the failure reading
settles transient or before-response at act under the legacy contract; otherwise
preserve the named error. Shared judgment-port availability retry remains a
separate owner from this execution-failure classification.

## Runtime composition and route readiness

Both client and daemon compositions supply the orchestrator's required
`agentManager` tool dependency. Route selection waits for the provider catalog
and benchmark store to settle before every pick. Supply `routeBenchmarkFor`
from the actual benchmark store; a price-only shortlist is not a benchmark-ranked
one. Startup model-listing failures contribute unavailable provider health beside
the runtime store, including keyless local providers whose endpoints may be down.
Configured credential identity covers both registered and catalog aliases.

After eligibility filtering and before sorting benchmark facts, prepare unknown
model identities through `routing.model-identity` with bounded concurrency and
memoization. Exact IDs need no reading; unresolved identities remain unscored.
Errors stop routing without a guessed match. Runtime composition and routing
proof use the same preparation owner. Validate cold first selection, warm reuse,
eligibility, failure, retry, cancellation and two routes sharing one identity.
Local regression fixtures do not establish live routing quality; the live
contract proof names its allowed provider keys explicitly.

Session turns, including resume, wait for settled catalog readiness and reject
with the actual `TURN_ERROR` so CLI users retain the reason. A routed agent with
its own model must not first resolve an unrelated configured default; lazy
default-model lookup occurs only when an agent without its own model needs it.
The CLI prints the route model once, without duplicating its provider prefix.
Use the checked-out branch as the current base, or the exact commit named by
HEAD when detached; never assume a branch named `main` exists or matches it.

Gemini thought signatures belong to the IDs of the function calls that supplied
them, are bounded in number and are attached to the corresponding returned call.
A response without tool calls in another conversation must not clear them.
No provider/account refusal should be hidden by a generic unchecked-turn message.

## Historical owner-reply compatibility

The legacy runner still has data and interpretation boundaries worth preserving
when reading or explicitly migrating old contracts. This section describes that
compatibility protocol, not the autonomous product workflow. Do not manufacture
an owner reply, reinterpret an old confirmation as autonomous authority, mark
criteria met without evidence, or restore an owner-wait fallback for autonomous
execution.

- An open legacy escalation does not structurally prove that the next session
  turn answers it. `contract.escalation-turn` reads `{ question, turn }`; a no at
  act routes as an ordinary turn. Other legacy readings enter the legacy reply
  interpreter, whose unclear response retains the question. The no side has the
  higher historical stakes.
- Legacy approval of an unsettled unit preserves the actual output from its last
  completion check, not `unit.answer ?? ''` before any pass set that answer.
  Unsettled context names the unshown goal and every unclean quality item as well
  as criteria; it must not silently settle unseen readings.
- A legacy writing-unclear reply asks only `forbids_writing`, not unrelated
  request-shape questions. The shaped decision records its reading ID.
- `Escalation.decisionIds` retains the readings behind its question. Acceptance
  of a historically escalated plan names those check readings and the reply,
  alongside shape/disposition evidence. These are provenance fields, not a grant
  for present execution.
- Below-threshold checkability/topology readings leave criteria judged normally.
  Only a later evidence check that cannot establish them yields unshown evidence
  and its legacy owner handling. New autonomous consumers use their own
  revise/evidence/defer/reject contract rather than this loop.

## Deterministic and validation boundaries

Text caps in evidence, correction, escalation and best-of-N are size/position
limits against the request budget, never semantic judgments. An `already exists`
match is permitted only against the exact machine message emitted by the owned
project-planning service. The CLI's `[y/N]` parser follows its explicitly dictated
permission format; it is not free-text semantic approval. Batteries use the
configured judgment port's model; per-battery pins must not override a configured
local System One model.

Retain unit, group and deliverable critical-band registrations. Historical
critical bands never act on a pass; below-threshold correct classifications may
therefore count as calibration misses and remain unshown (the historical
critical pass calibration boundary is 0.90). Do not alter their
meaning to improve a numeric score. Synthetic/regression tests and historical
live calibration are different evidence; historical accuracy/count tables remain
with the existing [engine project owner](https://linear.app/the-artificery/issue/TA-13/complete-remaining-engine-judgments-and-shared-hoists).

For an explicitly authorized live calibration, use
`bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/contract/judgment-registry.ts --only <names>`
with the registered batteries. Preserve the per-decision 0.90 calibration floor;
a historical passing run does not establish a later source revision.

Calibration fixtures must include integration-role units, dictated completion
reports, actual claims/gates/omitted paths, failing gates, mid-run quality,
complete deliverable output, best-of-N without criteria (including a `none`
selection at escalate), atomic coverage and
realistic plans, and legacy attempts-undecided/owner-decision-needed replies.
Preserve the claim-shown-by-gate regression and split-route uncertainty without
manufacturing semantic certainty or an execution receipt. Real provider billing
or account refusal is an operational failure, not evidence of a runner bug.

Focused validation covers completion-report parsing, claims/evidence,
worktree gates, resume, completion, owner-reply compatibility, check/correction,
plan checks/planner, client composition, provider discovery/benchmark readiness,
configured IDs, CLI, Gemini signatures, runner, lazy-model routing and benchmark
routing. Run them through the official guarded runner; use actual public
composition and recorded boundaries rather than source-text success assertions.

### Focused test files

- [test/client-runtime-services.test.ts](../../packages/engine/test/client-runtime-services.test.ts)
- [test/completion-report.test.ts](../../packages/engine/test/completion-report.test.ts)
- [test/contract/check.test.ts](../../packages/engine/test/contract/check.test.ts)
- [test/contract/claims.test.ts](../../packages/engine/test/contract/claims.test.ts)
- [test/contract/cli.test.ts](../../packages/engine/test/contract/cli.test.ts)
- [test/contract/completion.test.ts](../../packages/engine/test/contract/completion.test.ts)
- [test/contract/correction.test.ts](../../packages/engine/test/contract/correction.test.ts)
- [test/contract/evidence.test.ts](../../packages/engine/test/contract/evidence.test.ts)
- [test/contract/intake-route.test.ts](../../packages/engine/test/contract/intake-route.test.ts)
- [test/contract/owner-reply.test.ts](../../packages/engine/test/contract/owner-reply.test.ts)
- [test/contract/plan-checks.test.ts](../../packages/engine/test/contract/plan-checks.test.ts)
- [test/contract/planner.test.ts](../../packages/engine/test/contract/planner.test.ts)
- [test/contract/resume.test.ts](../../packages/engine/test/contract/resume.test.ts)
- [test/contract/route.test.ts](../../packages/engine/test/contract/route.test.ts)
- [test/contract/runner.test.ts](../../packages/engine/test/contract/runner.test.ts)
- [test/gemini-thought-signatures.test.ts](../../packages/engine/test/gemini-thought-signatures.test.ts)
- [test/model-benchmarks-settled.test.ts](../../packages/engine/test/model-benchmarks-settled.test.ts)
- [test/orchestration-worktree-gates.test.ts](../../packages/engine/test/orchestration-worktree-gates.test.ts)
- [test/orchestrator-runner-lazy-model.test.ts](../../packages/engine/test/orchestrator-runner-lazy-model.test.ts)
- [test/provider-configured-ids.test.ts](../../packages/engine/test/provider-configured-ids.test.ts)
- [test/provider-registry-live-model-discovery.test.ts](../../packages/engine/test/provider-registry-live-model-discovery.test.ts)
- [test/routing/benchmark-routing.test.ts](../../packages/engine/test/routing/benchmark-routing.test.ts)
