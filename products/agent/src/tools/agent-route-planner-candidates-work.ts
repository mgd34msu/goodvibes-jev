import type { RouteCandidateDraft } from './agent-route-planner.ts';
import { autonomousLike, directScheduleLike, fileRecoveryLike, hasAny, interactiveProcessCapabilityLike, processLifecycleLike, quote, researchRunnerLike, scheduleLike, visualResearchReportLike } from './agent-route-planner-helpers.ts';

export function addResearchScheduleExecutionRouteCandidates(
  lower: string,
  request: string,
  add: (candidate: RouteCandidateDraft) => void,
): void {
if ((researchRunnerLike(lower) || visualResearchReportLike(lower) || hasAny(lower, ['research', 'deep research', 'investigate', 'sources', 'citations', 'citation', 'source-backed', 'market map', 'literature', 'report'])) && !scheduleLike(lower)) {
    if (researchRunnerLike(lower)) {
      const runnerEffect = hasAny(lower, ['start ', 'start the', 'launch ', 'execute ', 'run ', 'run a ', 'run the ', 'open ']);
      add({
        id: 'research-browser-runner-readiness',
        label: 'Browser-backed research runner readiness',
        score: 96,
        userSurface: 'Research workspace',
        userOutcome: 'Check browser-backed research readiness and fallback routes before pretending live browser research can run.',
        why: 'The request mentions a browser-backed research runner or runner readiness.',
        modelRoute: `research action:"runner" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'research action:"runner" includeParameters:true',
        userRoute: 'Agent Workspace -> Research -> Browser runner readiness',
        requiresConfirmation: runnerEffect,
        missingFields: runnerEffect
          ? ['visible research run id or research question', 'published browser-runner ready state', 'confirmation before any live browser execution']
          : undefined,
        supportingRoutes: [
          `research action:"plan" query:${quote(request)} includeParameters:true`,
          'research action:"runs" includeParameters:true',
          'computer action:"browser" includeParameters:true',
          'computer action:"setup" query:"browser research runner" includeParameters:true',
        ],
        policy: 'Browser-runner readiness is read-only. Live browser-backed execution remains unavailable until the runner contract reports ready and the user confirms a scoped visible run.',
      });
    }

    if (visualResearchReportLike(lower)) {
      const renderEffect = hasAny(lower, ['render', 'open ', 'show ', 'save', 'export', 'share', 'publish']);
      add({
        id: 'research-visual-report-workflow',
        label: 'Visual research report workflow',
        score: 95,
        userSurface: 'Research workspace',
        userOutcome: 'Route visual report requests through reviewed source/report artifacts and expose browser-rendering gaps honestly.',
        why: 'The request mentions visual report packets, report rendering, or a browser/PWA research report view.',
        modelRoute: `research action:"plan" query:${quote(request)} includeParameters:true`,
        inspectRoute: 'research action:"reports" query:"visual report" includeParameters:true',
        userRoute: 'Agent Workspace -> Research -> Report artifacts',
        requiresConfirmation: renderEffect,
        missingFields: [
          'reviewed source bundle or saved report artifact id',
          ...(hasAny(lower, ['browser', 'pwa', 'render']) ? ['published browser/PWA report-rendering route before live browser rendering is considered ready'] : []),
          ...(renderEffect ? ['confirmation before report save, export, share, publish, or visible browser handoff'] : []),
        ],
        supportingRoutes: [
          'research action:"reports" query:"visual report"',
          `research action:"plan" query:${quote(request)} includeParameters:true`,
          'research action:"report" question:"..." sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."',
          'agent_artifacts action:"show" artifactId:"..." includeContent:true',
          'workspace action:"action" actionId:"research-report-artifacts" includeParameters:true',
        ],
        policy: 'Visual report planning is read-only. Markdown visual-report packets can be saved after confirmation; browser/PWA rendering is not claimed until a connected-host route publishes concrete readiness evidence.',
      });
    }

    add({
      id: 'deep-research-workflow',
      label: 'Visible research workflow',
      score: 92,
      userSurface: 'Research workspace',
      userOutcome: 'Turn research into a visible run, reviewed sources, and a sourced report artifact.',
      why: 'The request asks for research, source gathering, citations, or a report.',
      modelRoute: `research action:"plan" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'research action:"briefing"',
      userRoute: 'Agent Workspace -> Research',
      requiresConfirmation: hasAny(lower, ['start', 'run', 'create', 'save', 'report']),
      missingFields: hasAny(lower, ['start', 'run', 'create'])
        ? ['research question', 'deliverable or success criteria']
        : undefined,
      supportingRoutes: [
        'research action:"search" query:"..."',
        'research action:"create_run" title:"..." question:"..." confirm:true explicitUserRequest:"..."',
        'research action:"report" runId:"..." confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Planning and source search are read-only; visible run creation, source capture, lifecycle controls, and report saves stay confirmed.',
    });
  }

  if (directScheduleLike(lower)) {
    const reminder = hasAny(lower, ['remind', 'reminder']);
    const lifecycle = hasAny(lower, ['pause', 'resume', 'run schedule', 'edit', 'delete', 'cancel', 'enable', 'disable']);
    add({
      id: 'direct-schedule-route',
      label: reminder ? 'Reminder scheduling route' : 'Schedule management route',
      score: 98,
      userSurface: 'Work and schedules workspace',
      userOutcome: 'Create, inspect, edit, or control schedules through the first-class schedule tool with confirmation boundaries.',
      why: 'The request directly mentions reminders, schedules, cron, or schedule lifecycle controls.',
      modelRoute: `schedule action:"list" query:${quote(request)} limit:5`,
      inspectRoute: 'schedule action:"list"',
      userRoute: 'Agent Workspace -> Work & Approvals',
      requiresConfirmation: reminder || lifecycle || hasAny(lower, ['create', 'schedule ', 'cron']),
      missingFields: reminder
        ? ['reminder message', 'time or cadence', 'confirmation']
        : lifecycle
          ? ['schedule id', 'exact lifecycle action', 'confirmation']
          : ['task', 'time/cadence', 'success criteria for autonomous work', 'confirmation'],
      supportingRoutes: [
        'schedule action:"remind" message:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
        'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
        'schedule action:"edit|run|pause|resume|delete" scheduleId:"..." confirm:true explicitUserRequest:"..."',
        'autonomy action:"queue"',
      ],
      policy: 'Schedule listing is read-only. Reminder creation, autonomous schedule creation, edits, and lifecycle controls require exact fields plus confirmation.',
    });
  }

  if (autonomousLike(lower)) {
    add({
      id: 'autonomy-intake',
      label: 'Visible autonomy or schedule intake',
      score: scheduleLike(lower) || hasAny(lower, ['webhook', 'watcher', 'trigger', 'cron', 'schedule', 'remind', 'recurring']) ? 96 : 80,
      userSurface: 'Work and schedules workspace',
      userOutcome: 'Create or supervise ongoing work only through visible, cancellable routes.',
      why: 'The request sounds scheduled, recurring, event-triggered, long-running, or autonomous.',
      modelRoute: `autonomy action:"intake" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'autonomy action:"queue"',
      userRoute: 'Agent Workspace -> Work & Approvals',
      requiresConfirmation: hasAny(lower, ['create', 'start', 'schedule', 'remind', 'run', 'pause', 'resume', 'cancel', 'delete']),
      missingFields: ['exact cadence/event source when applicable', 'task', 'success criteria'],
      supportingRoutes: [
        'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
        'schedule action:"remind" message:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
        'agent_operator_method methodId:"watchers.create" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Autonomy intake is read-only; schedule, watcher, run-control, and delivery effects stay on the owning confirmed route.',
    });
  }

  if (fileRecoveryLike(lower)) {
    add({
      id: 'local-file-recovery',
      label: 'Local file edit recovery',
      score: 98,
      userSurface: 'Local file recovery',
      userOutcome: 'Inspect recent Agent file snapshots and apply exactly one confirmed undo or redo when needed.',
      why: 'The request mentions undo, redo, restore, revert, or recovery for file/edit/write/patch changes.',
      modelRoute: 'execution action:"recovery" includeParameters:true',
      inspectRoute: 'execution action:"history" includeParameters:true',
      userRoute: 'Main conversation (confirmed file-recovery route)',
      requiresConfirmation: hasAny(lower, ['undo', 'redo', 'restore', 'revert', 'roll back', 'rollback']),
      missingFields: ['recovery action when not obvious', 'snapshot target if multiple snapshots are available', 'confirmation before applying undo/redo'],
      supportingRoutes: [
        'execution action:"record" target:"..."',
        'agent_harness mode:"file_recovery" includeParameters:true',
        'agent_harness mode:"run_file_recovery" recoveryAction:"undo|redo" confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Recovery inspection is read-only. Applying an undo or redo snapshot is a single confirmed local file mutation with before/after state tracked by FileUndoManager.',
    });
  }

  if (interactiveProcessCapabilityLike(lower)) {
    const interactiveEffect = hasAny(lower, ['run ', 'start ', 'launch ', 'execute ', 'write ', 'send input', 'type ', 'sudo ']);
    add({
      id: 'interactive-process-capability',
      label: 'Interactive process, PTY, stdin, or sudo capability',
      score: 100,
      userSurface: 'Work and process supervision workspace',
      userOutcome: 'Check whether interactive CLI, stdin, PTY, or sudo mediation is safely available before starting hidden work.',
      why: 'The request mentions interactive terminal behavior, PTY, stdin/process input, sudo, or privilege prompts.',
      modelRoute: 'execution action:"process_capabilities"',
      inspectRoute: 'setup action:"item" setupItemId:"sudo-execution-posture"',
      userRoute: 'Agent Workspace -> Work & Approvals',
      requiresConfirmation: interactiveEffect,
      missingFields: interactiveEffect
        ? ['exact command or process id', 'whether foreground supervision is acceptable', 'confirmation before any start/write/credential effect']
        : undefined,
      supportingRoutes: [
        'process action:"capabilities"',
        'execution action:"processes" includeParameters:true',
        'setup action:"item" setupItemId:"sudo-execution-posture"',
        'terminal command:"..." background:true pty:true confirm:true explicitUserRequest:"..."',
        'process action:"write" processId:"..." data:"..." confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Capability inspection is read-only. PTY and sudo stay blocked unless the SDK/daemon publishes typed interactive and credential contracts; stdin writes require a discovered safe ProcessManager method plus confirmation.',
    });
  }

  if (processLifecycleLike(lower)) {
    const starting = hasAny(lower, ['run ', 'start ', 'launch ', 'execute ', 'terminal command', 'background:true', 'run in background', 'start in background']);
    const lifecycle = hasAny(lower, ['poll', 'log', 'wait', 'kill', 'stop', 'write', 'send input', 'stdin']);
    add({
      id: 'local-background-process',
      label: 'Local background process controls',
      score: 99,
      userSurface: 'Work and process supervision workspace',
      userOutcome: 'Start or manage long-running local commands through visible process ids, logs, and cancellation routes.',
      why: 'The request mentions terminal background commands, process lifecycle actions, stdin, PTY, or process supervision.',
      modelRoute: 'execution action:"processes" includeParameters:true',
      inspectRoute: 'execution action:"capabilities"',
      userRoute: 'Agent Workspace -> Work & Approvals',
      requiresConfirmation: starting || hasAny(lower, ['wait', 'kill', 'stop', 'write', 'send input']),
      missingFields: starting
        ? ['command', 'working directory when not the current workspace', 'confirmation']
        : lifecycle
          ? ['process id or session id']
          : undefined,
      supportingRoutes: [
        'terminal command:"..." background:true confirm:true explicitUserRequest:"..."',
        'process action:"list"',
        'process action:"poll|log|wait|kill|write" session_id:"..."',
        'process action:"capabilities"',
      ],
      policy: 'Process planning and listing are read-only. Starting commands, waiting, killing, and stdin writes use the first-class terminal/process confirmation boundaries with bounded redacted logs.',
    });
  }

  if (hasAny(lower, ['build', 'fix', 'implement', 'refactor', 'patch', 'code', 'test', 'review pr', 'review pull', 'lint', 'run command', 'shell', 'terminal', 'file edit', 'edit files'])) {
    const delegated = hasAny(lower, ['parallel', 'delegate', 'delegated', 'subagent', 'remote', 'worktree', 'background', 'isolated', 'isolation']);
    add({
      id: delegated ? 'delegated-build-work' : 'local-first-execution',
      label: delegated ? 'Delegated or isolated build work' : 'Local-first execution and file work',
      score: delegated ? 98 : 90,
      userSurface: delegated ? 'Work plan and delegation workspace' : 'Main conversation and Work workspace',
      userOutcome: delegated
        ? 'Use isolated or parallel execution only when it improves the user result.'
        : 'Use the current workspace directly when local read/edit/exec is sufficient.',
      why: delegated
        ? 'The request mentions parallelism, delegation, remote execution, worktrees, or isolation.'
        : 'The request is ordinary coding, shell, test, review, or file work in the current workspace.',
      modelRoute: delegated ? 'delegation action:"status" includeParameters:true' : 'execution action:"status" includeParameters:true',
      inspectRoute: delegated ? 'delegation action:"routes" includeParameters:true' : 'execution action:"route" target:"local"',
      userRoute: 'Agent Workspace -> Work & Approvals',
      requiresConfirmation: delegated,
      missingFields: delegated ? ['task scope', 'workspace or worktree target', 'success criteria', 'review expectation'] : undefined,
      supportingRoutes: delegated
        ? [
          'agent_work_plan action:"dispatch_agents" confirm:true explicitUserRequest:"..."',
          'delegation action:"route" target:"tui handoff"',
          'agent_harness mode:"agent_orchestration"',
        ]
        : [
          'execution action:"history"',
          'execution action:"processes"',
          'execution action:"recovery"',
        ],
      policy: delegated
        ? 'Delegation must preserve the original ask and produce visible status, artifacts, recovery, and review evidence.'
        : 'Local work remains serial and visible by default; long-running commands use tracked process routes.',
    });
  }
}
