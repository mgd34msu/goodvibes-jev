# Contract criteria

A contract's acceptance criteria are the conditions its work must meet before the contract runner accepts it. This document covers how criteria are traced to the person's words when the plan is written, carried into each unit's brief, read by Jev while the unit's sub-agent works, and nudged until every one reads met. They replace the constraint list of the retired write-review-fix-confirm process.

The code lives in `packages/engine/sdk/src/platform/contract/`. The build design is `docs/design/contract-runner.md` at the repository root.

See also: [Runtime events reference](./reference-runtime-events.md#contracts) for the `contracts` event domain, [Runtime orchestration](./runtime-orchestration.md) for the contract lifecycle, and [Observability](./observability.md) for event subscription.

---

## What a criterion is

A criterion is one checkable requirement. Every level of the contract tree has its own: the contract (the deliverable), each group, and each unit. The type is `Criterion` in `contract/types.ts`:

```ts
interface Criterion {
  readonly id: string;
  text: string;
  readonly origin: CriterionOrigin;     // 'stated' | 'derived' | 'integration' | 'fix' | 'owner'
  readonly quote?: string;              // 'stated' only: the person's words, verbatim
  readonly serves: readonly string[];   // ids of the criteria this one serves; empty for 'stated'
  disposition: CriterionDisposition;    // 'judged' | 'excluded' | 'met-by-structure'
  dispositionReason?: string;
  status: CriterionStatus;              // 'unread' | 'met' | 'unmet' | 'unshown'
  readings: CriterionReading[];         // every reading, oldest first
}
```

The unions are declared once in `packages/engine/sdk/src/events/contract.ts` (`CRITERION_ORIGINS`, `CRITERION_DISPOSITIONS`, `CRITERION_STATUSES`) and re-exported by the contract module.

### Origins

| Origin | Level | Where it comes from |
|---|---|---|
| `stated` | contract | The planner, with a `quote` that must appear in the person's ask |
| `derived` | group or unit | The planner; `serves` names the contract criteria it contributes to |
| `integration` | the integration unit | The planner; covers the parts fitting together |
| `fix` | a planned-fix unit | The fix planner; `serves` names the criteria of the unit, group or deliverable it repairs |
| `owner` | any | An owner amendment; the owner said it, so its trace is not asked again |

### Ids

| Level | Id form | Example |
|---|---|---|
| Contract | `c<n>` | `c2` |
| Group | `<groupId>.c<n>` | `g1.c1` |
| Unit | `<unitId>.c<n>` | `u3.c2` |
| Best-of-N attempt | `<unitId>#a<n>.c<k>` | `u2#a1.c1` |
| Owner amendment | `<target>.o<n>`, or `o<n>` for the deliverable | `u3.o1` |

### Dispositions and status

- **`judged`**: the default. Jev reads the criterion at every check.
- **`excluded`**: a topology-only criterion the plan cannot satisfy (see below). Never read and never failed; listed in the plan event, the contract tree and the final status line.
- **`met-by-structure`**: a topology-only criterion the plan's shape already meets. Also never read.

`status` is the latest verdict: `unread` until the first check, then `met`, `unmet` or `unshown` (Jev could not settle it from the evidence).

---

## Traced to the person's words: the plan

A contract starts from the person's ask, kept verbatim as `Contract.ask`. Jev first reads the request shape (`contract.request-shape`: whether delegation or writing is forbidden, whether parallel agents or several attempts are asked for). A read-only planner sub-agent then writes the plan as one fenced JSON block (`contract/planner.ts`):

```json
{
  "goal": "one sentence: what the whole task delivers",
  "criteria": [ { "id": "c1", "text": "checkable requirement", "quote": "the user's exact words it comes from" } ],
  "groups": [
    {
      "id": "g1", "title": "...", "goal": "...", "dependsOn": [],
      "criteria": [ { "id": "g1.c1", "text": "...", "serves": ["c1"] } ],
      "units": [
        {
          "id": "u1", "title": "...", "goal": "...", "role": "implement",
          "brief": "what to do, where, and how it fits the whole",
          "dependsOn": [], "files": ["src/a.ts"], "attempts": 1,
          "criteria": [ { "id": "u1.c1", "text": "...", "serves": ["c1"] } ]
        }
      ]
    }
  ]
}
```

A plan launched from a drafted plan (a plan proposal or workstream draft, `runner.startFromPlan`, `contract/draft-plan.ts`) keeps its drafted units; the planner writes the contract criteria and each unit's criteria for them, and every check below still runs.

### Code checks on criteria

`validateContractPlan` (`contract/plan-schema.ts`) runs first, with no Jev call. The problem codes that concern criteria:

| Code | Problem |
|---|---|
| `no-criteria` | The plan has no contract criterion |
| `unit-without-criteria` | A unit has no criterion |
| `serves-missing` | A unit or group criterion has an empty `serves` list |
| `serves-unknown` | `serves` names a contract criterion that does not exist |
| `uncovered-criterion` | No unit criterion serves a contract criterion |
| `quote-not-found` | A contract criterion's `quote` is missing or does not appear in the ask after normalization |

### Jev checks on criteria

`contract/plan-checks.ts` runs these concurrently once the code checks pass. Each is a named decision registered in `contract/judgment-registry.ts`, with its questions, bands and fixtures in one file under `contract/batteries/`.

| Decision | Asked of | Question | Problem when |
|---|---|---|---|
| `contract.criterion-trace` (fidelity checker) | each contract criterion: claim "The user requires: <text>", source the ask, quote its quote | does the ask support the claim | not supported at act: `untraced` |
| `contract.plan-coverage` | the plan: `{ request, criteria }` | does the request state a requirement, limit or preference no criterion covers | yes at any outcome, or no below act: `uncovered-requirement` |
| `contract.criterion-shape` | each contract criterion: `{ request, criterion }` | is it checkable from the finished work; is it only about how agents are arranged | not checkable: `not-checkable`; topology-only: a disposition (below) |
| `contract.unit-shape` | each unit | its role; does it narrow what the criteria it serves require | a review, test or verify unit: `verification-unit`; narrowing: `narrows` |

The trace check's supports side is read at high stakes: a criterion wrongly read as supported binds every unit to something the person never asked for. Coverage clears only on a no at act, since a missed requirement is work the contract would pass without doing.

### Topology-only criteria

A criterion such as "one agent per package, all in parallel" is met or missed by the plan's shape, not by the work. When `topology_only` reads yes at act, code gives it a disposition instead of judging it:

- **The plan honours a parallel request** (some group runs two or more independent units): `met-by-structure`, with the reason naming that group.
- **Otherwise**: `excluded`, with the reason "requires an agent arrangement this plan does not use".

The final status line counts excluded criteria, for example "1 excluded".

### Repair and the owner

Every problem goes back to the planner in one repair request, up to `contract.planRepairLimit` repairs (default 2). When problems remain, the contract waits on the owner with a `plan-unresolved` escalation that lists them. The owner can approve the plan as it stands, amend it (the reply goes to the planner as an instruction), or stop the contract.

---

## Carried into unit briefs

`buildUnitBrief` (`contract/brief.ts`) builds each unit's task in code from the contract tree. Its sections, in order:

1. `Contract goal:` the contract's goal.
2. The unit's id, title, goal and the planner's brief.
3. `Acceptance criteria for this unit:` every judged unit criterion by id and text, each followed by the contract criteria it serves.
4. The group's goal, the sibling units and the units this one builds on, so the parts stay compatible with the whole.
5. For an integration unit, what every other unit delivered.
6. The tool line: read-only, or read, write, edit and run commands.
7. One fixed paragraph: "Your work is checked against these criteria while you work and when you finish. If a check finds a problem you will receive a correction; fix it and finish again."

A criterion line looks like this:

```
- [u1.c1] The export command writes orders.csv (serves [c1] The CLI has an export command that writes all orders to orders.csv)
```

The brief never asks the agent to list constraints or review itself. The criteria belong to the contract, so nothing the agent writes can add, rename or drop one. A fresh agent on a unit that was already checked (a transport or silence retry, a fresh-agent correction, a respawn after a restart) gets the brief followed by a "Previous checks" section with the latest verdicts (`briefWithPreviousChecks`).

---

## Read by Jev while the unit works

`contract/check.ts` runs one check: collect evidence, ask Jev, fold the readings into a result in code. At most one check per unit is in flight.

### When checks run

| Trigger | When | Evidence |
|---|---|---|
| `turn-end` | A turn whose tool calls include `write`, `edit` or `exec`, when `contract.midRunChecks` is on | diff and commands; no gates or claims yet |
| `completion` | The agent tries to finish; the runner holds it at that point | diff, claim verification, gates, output |
| `agent-failed` | The agent hit its turn budget or a circuit breaker, or the watchdog stopped a silent agent | full |
| `fix-passed` | The unit's planned-fix group passed | full |
| `resume` | The runner restarted while the unit was held, checking or nudged | full |
| `owner-amend` | The owner changed the unit's criteria | full |

### The readings

- **Criteria and goal: `contract.unit-judge`** (judge pattern). One request per check asks, for each judged criterion, "does the output fail it, or does the evidence fail to show it is met", and once whether the output fails the unit's goal. The pass side carries the higher stakes: `contract.acceptanceStakes` chooses between the two bands declared in `batteries/unit-judge.ts` (`high` by default, or `critical`).
- **Quality: `contract.unit-quality`**, asked in parallel: placeholder code, weakened tests, broken existing behaviour, out-of-scope changes, hidden failures, and claims the evidence does not show.
- **Severity: `contract.unmet-severity`**, one per unmet criterion (critical, major, minor), read after the nudge is sent so it never delays one. It orders and labels; it never decides whether work passes.

### Readings to verdicts

| Judge reading | Verdict |
|---|---|
| leans "fails", any outcome | `unmet` |
| "does not fail" at act | `met` |
| "does not fail" below act, or no reading | `unshown` |

### Check results

Code applies these in order:

1. A `turn-end` check is recorded; it nudges only for a regression or a mid-run quality problem at act.
2. A failed gate is a nudge, whatever the readings say.
3. Unverified claims (files reported as created that are not on disk) are a nudge.
4. Any unmet criterion, unmet goal or quality problem is a nudge.
5. Anything `unshown` is a nudge asking for evidence, until `contract.evidenceNudgeLimit` consecutive unsettled checks; then the owner is asked (`unsettled`).
6. Every judged criterion met, goal met, quality clean, gates passed and claims verified: `pass`, and the hold releases.

A pass is the only way a unit reaches `passed`. Groups and the deliverable are checked the same way against their own criteria (`contract.group-judge`, `contract.deliverable-judge`) once their parts pass; excluded and met-by-structure criteria are left out and reported.

---

## Nudged until they read met

`buildNudge` (`contract/nudge.ts`) builds the nudge in code, with its order and wording fixed in that file:

```
Contract check 2 on "Add the export command": the work does not pass yet. Fix what is listed, then finish your turn; it will be checked again.

Not met:
- [u1.c2] --since <date> exports only orders newer than the date (major)
Regressed (these were met at check 1 and are not met now; restore them without undoing other fixes):
- [u1.c1] The export command writes orders.csv
Not shown (show evidence that these are met: run the command that proves it, or cite the file and line):
- [u1.c3] The tests for the export command pass
Quality problems:
- Placeholder or stub code remains where working behaviour is required.
Gate failures:
- typecheck: <last 40 lines of its output>

Already met (binding: do not break these):
- [u1.c4] The existing import command is unchanged
```

Empty sections are left out. The "Already met" list restates every criterion whose latest verdict is met, so a correction does not silently break what works; one that does is caught as a regression.

### Delivery

| Agent state | Delivery |
|---|---|
| Held at its completion point | the hold returns the text; it becomes the next user turn |
| Running (a `turn-end` nudge) | a `steer` message on the agent message bus from `contract-runner`, injected before the next model call |
| Stopped (`failed`, or `completed` after a fix group, a restart or an amendment) | `AgentManager.wakeWithSteer`, which resumes the agent with the nudge |
| Gone (process restart) | a fresh agent with the brief, "Previous checks", and the nudge as its first turn |

### Regression, stall and correction

`contract/progress.ts` compares recorded verdicts in code:

- **Regression**: a criterion that read met and now reads unmet. Always a nudge, and a `CONTRACT_CRITERION_REGRESSED` event.
- **Progress**: more criteria met than the previous check, or fewer failing gates, quality problems or claim failures.
- **Stall**: `contract.stallLimit` consecutive checks without progress (turn-end checks do not count), the same criterion regressed twice, or `contract.maxNudgesPerUnit` nudges.

A stalled unit is routed by `contract.stall-route` (`contract/correction.ts`): split the remaining problems into a planned-fix group whose `fix` criteria serve the unmet ones, give the unit a fresh agent, or ask the owner. After `contract.maxFixRounds` fix rounds and fresh agents, the owner is asked without a reading.

### The owner

An escalation names the unmet and unshown criteria (`contract/escalation.ts`). The owner's reply is read with `contract.owner-reply`: approve, amend or reject. Approval can accept `unshown` readings; it cannot pass a criterion that reads `unmet`. An amendment rewrites the target's criteria with origin `owner` and checks the target again. Rejecting stops the contract.

---

## Where criteria show

| Surface | What it carries |
|---|---|
| `CONTRACT_PLANNED` | every criterion with origin, quote, serves and disposition |
| `CONTRACT_PLAN_CHECKED` | one plan check's problems by code and target |
| `CONTRACT_CHECKED` | one reading per criterion: `criterionId`, `verdict`, `probabilityUnmet`, `outcome` |
| `CONTRACT_NUDGED` | the nudge's kinds and criterion ids |
| `CONTRACT_CRITERION_REGRESSED` | the criterion, the check it was met at, and the check that found it unmet |
| `CONTRACT_ESCALATED` | the question and the unmet criterion ids |
| `CONTRACT_PASSED` | `criteriaMet`, `criteriaJudged`, `excluded`, `nudges` |
| Fleet nodes | `ProcessCheckSummary` on contract, group and unit nodes: each criterion's latest verdict, met and judged counts, nudges |

The contract tree persists every reading under `.goodvibes/contracts/<contractId>.json`, so a restarted runner resumes with the full history.

---

## Next reads

- [Runtime events reference](./reference-runtime-events.md#contracts): every `CONTRACT_*` event shape
- [Runtime orchestration](./runtime-orchestration.md): the contract lifecycle, groups and settings
- [Observability](./observability.md): event domain subscription
