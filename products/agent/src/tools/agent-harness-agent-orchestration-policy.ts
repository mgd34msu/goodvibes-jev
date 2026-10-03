export const AGENT_TOOL_MODES = [
  'spawn',
  'batch-spawn',
  'list',
  'templates',
  'status',
  'get',
  'budget',
  'plan',
  'wait',
  'message',
  'cancel',
  'wrfc-chains',
  'wrfc-history',
  'cohort-status',
  'cohort-report',
] as const;

export const AGENT_TEMPLATES = ['orchestrator', 'engineer', 'reviewer', 'tester', 'researcher', 'integrator', 'general'] as const;

export function agentOrchestrationDecisionCards(agentToolAvailable: boolean): readonly Record<string, unknown>[] {
  return [
    {
      id: 'serial-by-default',
      label: 'Stay serial by default',
      status: 'ready',
      chooseWhen: ['Ordinary chat, planning, research, setup, local context, and short current-workspace tool work.'],
      route: 'main conversation',
      reason: 'Lowest-friction route for the user when parallelism does not improve outcome.',
    },
    {
      id: 'visible-single-agent',
      label: 'Spawn one visible agent',
      status: agentToolAvailable ? 'ready' : 'unavailable',
      chooseWhen: ['A bounded autonomous task can run independently with visible status and cancellation.'],
      requiredFields: ['task', 'successCriteria or requiredEvidence when outcome quality matters'],
      modelRoute: 'agent { mode: "spawn" }',
      inspectRoute: 'agent_harness mode:"agent_orchestration"',
    },
    {
      id: 'visible-batch-spawn',
      label: 'Batch-spawn independent agents',
      status: agentToolAvailable ? 'ready' : 'unavailable',
      chooseWhen: ['Tasks are genuinely independent and parallel work materially improves time-to-result.'],
      doNotUseWhen: ['Review/test/verification role fanout for one deliverable; that collapses to one owner chain.'],
      requiredFields: ['tasks[]', 'authoritativeTask for the original user ask when applicable'],
      modelRoute: 'agent { mode: "batch-spawn" }',
      inspectRoute: 'agent_harness mode:"agent_orchestration"',
    },
    {
      id: 'managed-multi-runner-plan',
      label: 'Use a managed multi-runner plan',
      status: agentToolAvailable ? 'ready' : 'unavailable',
      chooseWhen: ['A large task already has approval for parallel work and needs milestones, evidence, and cancellation routes.'],
      requiredFields: ['original user ask', 'lane reason', 'success criteria', 'per-runner evidence', 'cancel/recovery route'],
      modelRoute: 'agent_work_plan action:"dispatch_agents" ids:["..."] confirm:true explicitUserRequest:"..."',
      inspectRoute: 'agent_harness mode:"agent_orchestration"',
      policy: 'Read-only plan surface first; approved work-plan dispatch, spawn, message, wait, cancel, or remote mutation stays on confirmed first-class routes.',
    },
    {
      id: 'inspect-or-control-visible-agent',
      label: 'Inspect or control a visible agent',
      status: agentToolAvailable ? 'ready' : 'unavailable',
      chooseWhen: ['The user asks for progress, budget, plan, message, wait, cancel, WRFC chain, or cohort status.'],
      modelRoutes: ['agent { mode: "list" }', 'agent { mode: "get" }', 'agent { mode: "message" }', 'agent { mode: "wait" }', 'agent { mode: "cancel" }'],
    },
    {
      id: 'hidden-fanout-blocked',
      label: 'Block hidden fanout',
      status: 'blocked',
      chooseWhen: ['A request implies invisible background agents, unmanaged parallel coding workers, or orphaned jobs.'],
      saferRoutes: ['visible work plan', 'research run', 'confirmed schedule', 'agent { mode: "spawn" }', 'delegation action:"status"'],
    },
  ];
}
