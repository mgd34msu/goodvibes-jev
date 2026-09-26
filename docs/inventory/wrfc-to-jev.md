# WRFC functions and their Jev form

Jev takes the place of WRFC. It does all of the judging on all of the work, and every function WRFC performed carries into the contract runner, with one change of method: WRFC judged finished work with a reviewer agent and repaired it in review and fix loops; the contract runner judges work while a sub-agent is doing it and corrects course with fast, real-time nudges to that sub-agent. Sub-agents stay.

Each entry below names what WRFC did, the purpose it served, and how the Jev version serves the same purpose. The old code is the reference for the purpose, not a template to copy. Sources: `agents/wrfc-*.ts`, `core/wrfc-routing.ts`, `tools/agent/wrfc-batch-policy.ts`, `runtime/fleet/adapters/wrfc.ts`, `orchestration/controller-compat.ts`, `orchestration/fix-workstream-runner.ts` in goodvibes-sdk.

## Deciding what the work is

| WRFC function | Purpose | Jev version |
|---|---|---|
| Routing nudge: regexes decide a message asks for chain work and inject "start a WRFC owner chain" (`isWrfcWorkflowRequest`, `buildWrfcWorkflowRoutingPrompt`) | Send real work to the reviewed pipeline instead of an unchecked single turn | Intake dispatch reads the request (converse, answer, contract work) and routes contract work to the runner; no text is injected into the model's prompt |
| No-delegation guard: 11 regexes detect "do it yourself", "no agents" (`userProhibitsDelegation`) | The user's explicit instruction not to delegate always wins | A yes/no reading "does the user forbid delegating this work to sub-agents?" gates the runner before any spawn |
| Engineer constraint enumeration addendum: the engineer lists the task's explicit constraints as acceptance criteria before working, with calibration rules (no invented constraints, at most about 16) | The user's stated requirements become checkable criteria, and nothing that was not asked for becomes one | The planning step sets the goal and acceptance criteria up front (intent R); a Jev check confirms each criterion traces to the user's words and that no stated requirement is missing, before units start |
| Scope preservation: the authoritative user ask replaces a narrower model-proposed task; restrictive tool lists that remove write or exec from implementation work are ignored (`resolveAuthoritativeWrfcScope`, `resolveNarrowedRootSpawnScope`, `resolveImplementationToolContract`) | A sub-agent's task can never shrink what the user asked for | A yes/no reading "does the proposed unit drop or narrow anything the goal requires?" before spawn; implementation units keep write and exec tools unless the ask forbids writing (a yes/no reading, not a regex) |
| Role-fanout collapse: a batch that splits one deliverable into separate engineer, reviewer, tester and verifier root agents becomes one owner chain; several implementation deliverables become one compound chain (`evaluateWrfcBatchPolicy`) | Review and testing are phases of one piece of work, not independent agents with their own scope | Verification is Jev's job inside the unit, so reviewer, tester and verifier roots are not spawned; a choice reading classifies each proposed task (implement, review, test, verify, design only) |
| Explicit parallel fan-out honoured (`userRequestsParallelFanout`) and constraints that depend on agent topology excluded after a collapse (`isFanoutShapeConstraintText`) | Do what the user asked about agent layout, and never fail work on a criterion the system made impossible | A yes/no reading "does the user ask for separate agents in parallel or one per unit?" shapes the plan's groups; a per-criterion yes/no "can this only be met by a particular arrangement of agents?" marks criteria the plan cannot satisfy, which are reported, never failed |
| Compound chains: several deliverables, each engineered and reviewed, then an integrator, then a final full-scope review (`startCompoundEngineeringChain`, `startIntegration`) | Large work is split, each part is right, and the whole still fits together | Groups and units (intent R); Jev judges each unit against its criteria, each group on completion, and the deliverable at the end; integration is a unit with its own criteria |

## Doing the work

| WRFC function | Purpose | Jev version |
|---|---|---|
| Spawning phase agents with the owner's model, provider, routing and reasoning effort, or a per-role route selector (`spawnWrfcAgent`, `selectChildRoute`) | Each piece of work runs on an appropriate model, with the reason recorded | Units run on sub-agents chosen by the routing subsystem (intent: route planner over the whole catalog); the route reason is recorded on the unit |
| Active-chain cap of 6 with a queue, and dequeue on completion (`MAX_ACTIVE_CHAINS`, `chainQueue`) | Bound concurrent work so the host and budget are not swamped | The runner's scheduler caps concurrent units and queues the rest (ported orchestration scheduler, budget and elastic pool) |
| Per-work-item worktree isolation, dependency ordering, cancellation, budget checks (orchestration engine, used by WRFC's fix path) | Units do not trample each other and run in a sound order | Kept: the ported orchestration machinery runs units |
| Agent-silence watchdog: a chain fails when its active agent emits nothing for the configured time (`tickWatchdog`) | A hung agent is noticed instead of running forever | Kept as a liveness check on running units; a silent unit is reported and its unit is retried or failed |
| One bounded retry after a transport failure, respawning the same role with the same inputs (`retryTransportFailure`) | A network blip does not cost the whole piece of work | Kept; whether a failure is transient is a Jev reading (intent: failure transience before retry, cooldown or dead-letter), not a message regex |
| Claim verification: files an agent says it created or modified are checked on disk, with `git diff` as corroboration; unverifiable claims block a pass (`verifyEngineerClaims`) | Work that was claimed but not done is caught | Kept as a deterministic check on every unit's reported changes; its result is evidence the Jev judge reads, and a failed check is an immediate nudge |
| Quality gates: configured commands (typecheck, lint, test, build) run with skip detection and a timeout; failures spawn a gate fixer (`runWrfcGateChecks`, `executeGateCommand`, `buildGateFailureTask`) | The work passes the project's own checks | Gates run as deterministic checks when a unit or group finishes; a failing gate becomes a nudge to the unit's sub-agent with the gate output, instead of a new fixer agent |
| Sub-deliverable engineer brief: implement only this part, keep the whole ask in mind (`buildSubtaskEngineerTask`) | Parts stay compatible with the whole | Each unit's brief carries the goal, the unit's criteria, and the group context |

## Judging the work

| WRFC function | Purpose | Jev version |
|---|---|---|
| Reviewer agent spawned after the engineer finishes, with a long review brief: derive an acceptance checklist, independently exercise the deliverable, treat compilation, diffs and the engineer's tests as supporting evidence only, resolve every reported uncertainty, re-run the whole contract after fixes, never rely on a hidden grader (`buildReviewTask`, `startReview`) | Work is verified against what was asked, by someone other than the worker, on real evidence | The Jev judge pattern reads each acceptance criterion against the unit's output and evidence (command output, test results, files) while the sub-agent works; the checklist is the plan's criteria; the evidence rules become what evidence the runner collects for each unit |
| Review score read from reviewer prose with regexes; pass requires score at or above a threshold (9.9 of 10 by default); fail and issue severity also read from prose (`extractScoreFromText`, `extractPassedFromText`, `extractIssuesFromText`) | A clear pass or fail on the work, with the problems named | Judge verdict (pass, fail, uncertain) from per-criterion readings with bands; unmet criteria are the named problems, each with a severity reading; no prose score |
| Acceptance-checklist gate: any unverified checklist item, or no checklist at all, blocks a pass (`evaluateAcceptanceChecklistGate`) | Correct but not what was asked cannot pass | Every criterion must read as met; a criterion with no reading is unmet |
| Constraint findings: every constraint needs a finding; a missing finding counts as unmet; findings for unknown constraints are flagged; constraint failure blocks a pass regardless of score (`evaluateConstraintSet`, `augmentReviewWithMissingConstraintFindings`) | Every stated requirement is checked, and silence is not approval | Each criterion is its own yes/no reading, so none can be skipped; an unanswered reading is an error, not a pass |
| Constraint continuity: a fixer that renames, drops or adds constraints is flagged; the original list stays authoritative (`canonicalizeFixerReportConstraints`) | Fixing one thing never silently changes what the work must satisfy | The criteria belong to the plan, not to the sub-agent's report, so a sub-agent cannot alter them |
| Score regression warning: two consecutive scores below the first (`emitWrfcScoreRegression`) | Notice when attempts make things worse | Criterion readings are tracked over the unit's life; a criterion that was met and then reads unmet is an immediate nudge and is surfaced |
| Controller verdict recorded separately from the reviewer's own claim (`lastReviewVerdict`) | Consumers see the true outcome | The judge verdict is the only verdict; it is recorded on the unit and in the decision log |

## Correcting the work

| WRFC function | Purpose | Jev version |
|---|---|---|
| Review/fix loop: a failed review spawns a fixer or a planned-fix workstream, then a fresh review, up to 5 fix attempts (`startPlannedFix`, `fix-workstream-runner.ts`, `processReview`) | Problems found get fixed until the work passes or clearly cannot | Real-time nudges: when a criterion reads unmet while the sub-agent works, the runner sends that sub-agent a short, specific correction at once; no separate fixer and no re-review cycle. A unit that cannot be corrected within its budget fails with the unmet criteria named |
| Fixer and reviewer constraint addenda: preserve satisfied constraints, satisfy unmet ones, stop and report a conflict rather than regress (`buildFixerConstraintAddendum`, `buildReviewerConstraintAddendum`) | Corrections never break what already works | Nudges name the unmet criterion and restate the met ones as binding; a reading that a correction regressed a met criterion is itself a nudge |
| Planned-fix decomposition: review findings become a dependency graph of fix tasks run by the workstream engine (`planFixWorkstream`) | Large corrections are done as structured work, not one prompt | Kept in the ported orchestration: a correction too big for a nudge becomes new units in the plan |
| Engineer self-check before the final report (the second part of the engineer addendum) | Workers catch their own misses | Unneeded as an instruction: Jev reads the criteria continuously |

## Finishing the work

| WRFC function | Purpose | Jev version |
|---|---|---|
| Scoped auto-commit: commit only paths the chain's agents reported touching (the edit ledger), with a full commit message body; a commit failure is a warning on a passing result, never a failure (`autoCommit`, `collectChainTouchedPaths`, `buildAutoCommitMessage`) | Passing work is committed without sweeping in unrelated changes | Kept: the runner commits the deliverable's touched paths when the deliverable passes, with the same honesty about skipped or failed commits |
| Answer separate from status: a person receives the last worker's answer (the report's prose summary), never the chain status line; operator status stays on operator surfaces (`renderWrfcChainAnswer`, `completeOwnerAgent`) | The person who asked gets the answer, not bookkeeping | Kept: the deliverable's answer goes to the person; the contract tree's status goes to operator surfaces |
| Honest outcome wording for review and commit (`describeReviewOutcome`, `describeCommitOutcome`) | Status never implies something happened when it did not | Kept for the contract tree's status line |
| Cancel is not failure: an operator stop reads as cancelled everywhere, with "N files already modified on disk" (`cancelChain`) | The operator sees exactly what an interrupted run left behind | Kept for cancelled contracts |
| Usage and tool-call totals rolled up from every sub-agent onto the owner, and the owner repriced from its children (`aggregateChainUsage`, `repriceWrfcOwnerNode`) | Cost and effort of the whole piece of work are visible and accurate | Kept: contract, group and unit totals roll up from sub-agents |
| Execution-plan items and project work-plan tasks kept in step with agent phases (`completePlanItemsForAgent`, `upsertWrfcWorkPlanTask`) | The plan views reflect the work as it happens | Kept: units map to work-plan tasks, and their status follows the unit |

## Surviving and showing the work

| WRFC function | Purpose | Jev version |
|---|---|---|
| Chain persistence with schema versions, import that refuses to overwrite live work, and resume from whichever phase was interrupted (`serializeChain`, `importChain`, `resumeChain`) | Work survives restarts | Kept for contracts: the tree persists and a restarted runner resumes each unfinished unit |
| Zombie reaping: an imported chain whose agents all died is marked failed (`reapZombieChain`) | Nothing shows as running forever after a restart | Kept |
| Owner decision audit: every orchestration choice with its reason, model and score (`appendOwnerDecision`) | Why the work went the way it did is reviewable | The decision log records every Jev reading; runner choices (spawn, nudge, retry, commit) are recorded on the contract tree |
| Workmap: append-only JSONL journal of chain events per session (`WrfcWorkmap`) | A durable trail of what happened | Folded into the contract tree persistence and the decision log |
| Workflow and orchestration events: chain created, state changed, review completed, gate result, auto-committed, chain passed or failed (`wrfc-runtime-events.ts`) | Surfaces follow the work live | Contract events (intent: the orchestration domain becomes the contract domain) |
| Fleet view: chains and subtasks as process nodes, with derived kill detection, cost with provenance, a model descriptor, and a review summary with the checklist (`adaptChain`, `adaptSubtask`, `deriveReviewSummary`) | Operators see the work tree, its cost and what was verified | Contract-tree views (intent: fleet panels become the contract-tree views), showing each criterion's reading |
| External work adapter for partner surfaces: dispatch, poll, cancel, result (`WrfcExternalWorkBridge`) | Surfaces that cannot host the runner can still drive work | Kept as the contract runner's external seam, used by the daemon host (intent: the runner works as a CLI and as the daemon hosted-session host) |
| Settings: score threshold, fix attempts, auto-commit, commit scope, gates, heartbeat timeout, transport retry (`wrfc-config.ts`) | The workflow is tunable | Contract runner settings; score threshold and fix attempts become band and nudge-budget settings |
| Standard phase template and single-task workstream spec (`engineerReviewPhases`, `fromChainSpec`) | One definition of the normal flow | The runner's default plan shape for a single-unit task |

## Best-of-N

| WRFC function | Purpose | Jev version |
|---|---|---|
| Sibling attempts and a model call that scores candidates and proposes a winner (`orchestration/attempts.ts`, `orchestration/judge.ts`) | Pick the best of several tries | The select pattern (candidate selection, or none) with a fit reading per candidate (intent R) |
