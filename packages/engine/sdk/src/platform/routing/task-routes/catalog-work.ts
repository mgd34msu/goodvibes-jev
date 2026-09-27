/**
 * Research, schedule, autonomy, file recovery, process and build routes.
 * Wording is the agent's; variants come from slot readings (slots.ts).
 */
import { quote } from './text.js';
import type { TaskRouteEntry } from './types.js';

const researchRunner: TaskRouteEntry = {
  id: 'research-browser-runner-readiness',
  description: 'Whether the browser-backed research runner is ready, or running live browser-backed research through it.',
  build: (request, slots) => ({
    id: 'research-browser-runner-readiness',
    label: 'Browser-backed research runner readiness',
    userSurface: 'Research workspace',
    userOutcome: 'Check browser-backed research readiness and fallback routes before pretending live browser research can run.',
    why: 'The request mentions a browser-backed research runner or runner readiness.',
    modelRoute: `research action:"runner" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'research action:"runner" includeParameters:true',
    userRoute: 'Agent Workspace -> Research -> Browser runner readiness',
    requiresConfirmation: slots.starts,
    missingFields: slots.starts
      ? ['visible research run id or research question', 'published browser-runner ready state', 'confirmation before any live browser execution']
      : undefined,
    supportingRoutes: [
      `research action:"plan" query:${quote(request)} includeParameters:true`,
      'research action:"runs" includeParameters:true',
      'computer action:"browser" includeParameters:true',
      'computer action:"setup" query:"browser research runner" includeParameters:true',
    ],
    policy: 'Browser-runner readiness is read-only. Live browser-backed execution remains unavailable until the runner contract reports ready and the user confirms a scoped visible run.',
  }),
};

const researchVisualReport: TaskRouteEntry = {
  id: 'research-visual-report-workflow',
  description: 'A visual research report or report packet: building, rendering, viewing or exporting a research report with visuals.',
  build: (request, slots) => {
    const renderEffect = slots.starts || slots.changes || slots.opensUi;
    return {
      id: 'research-visual-report-workflow',
      label: 'Visual research report workflow',
      userSurface: 'Research workspace',
      userOutcome: 'Route visual report requests through reviewed source/report artifacts and expose browser-rendering gaps honestly.',
      why: 'The request mentions visual report packets, report rendering, or a browser/PWA research report view.',
      modelRoute: `research action:"plan" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'research action:"reports" query:"visual report" includeParameters:true',
      userRoute: 'Agent Workspace -> Research -> Report artifacts',
      requiresConfirmation: renderEffect,
      missingFields: [
        'reviewed source bundle or saved report artifact id',
        ...(slots.opensUi ? ['published browser/PWA report-rendering route before live browser rendering is considered ready'] : []),
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
    };
  },
};

const deepResearch: TaskRouteEntry = {
  id: 'deep-research-workflow',
  description: 'A one-off research job now: investigating a topic, gathering and citing sources, producing a sourced report.',
  build: (request, slots) => {
    const effect = slots.starts || slots.changes;
    return {
      id: 'deep-research-workflow',
      label: 'Visible research workflow',
      userSurface: 'Research workspace',
      userOutcome: 'Turn research into a visible run, reviewed sources, and a sourced report artifact.',
      why: 'The request asks for research, source gathering, citations, or a report.',
      modelRoute: `research action:"plan" query:${quote(request)} includeParameters:true`,
      inspectRoute: 'research action:"briefing"',
      userRoute: 'Agent Workspace -> Research',
      requiresConfirmation: effect,
      missingFields: slots.starts ? ['research question', 'deliverable or success criteria'] : undefined,
      supportingRoutes: [
        'research action:"search" query:"..."',
        'research action:"create_run" title:"..." question:"..." confirm:true explicitUserRequest:"..."',
        'research action:"report" runId:"..." confirm:true explicitUserRequest:"..."',
      ],
      policy: 'Planning and source search are read-only; visible run creation, source capture, lifecycle controls, and report saves stay confirmed.',
    };
  },
};

const directSchedule: TaskRouteEntry = {
  id: 'direct-schedule-route',
  description: 'A single reminder or a named schedule itself: remind me at a time, create a cron schedule, or list, pause, resume, edit or delete an existing schedule.',
  build: (request, slots) => ({
    id: 'direct-schedule-route',
    label: slots.reminder ? 'Reminder scheduling route' : 'Schedule management route',
    userSurface: 'Work and schedules workspace',
    userOutcome: 'Create, inspect, edit, or control schedules through the first-class schedule tool with confirmation boundaries.',
    why: 'The request directly mentions reminders, schedules, cron, or schedule lifecycle controls.',
    modelRoute: `schedule action:"list" query:${quote(request)} limit:5`,
    inspectRoute: 'schedule action:"list"',
    userRoute: 'Agent Workspace -> Work & Approvals',
    requiresConfirmation: slots.reminder || slots.controls || slots.changes || slots.starts,
    missingFields: slots.reminder
      ? ['reminder message', 'time or cadence', 'confirmation']
      : slots.controls
        ? ['schedule id', 'exact lifecycle action', 'confirmation']
        : ['task', 'time/cadence', 'success criteria for autonomous work', 'confirmation'],
    supportingRoutes: [
      'schedule action:"remind" message:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      'schedule action:"edit|run|pause|resume|delete" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      'autonomy action:"queue"',
    ],
    policy: 'Schedule listing is read-only. Reminder creation, autonomous schedule creation, edits, and lifecycle controls require exact fields plus confirmation.',
  }),
};

const autonomyIntake: TaskRouteEntry = {
  id: 'autonomy-intake',
  description: 'Ongoing work the agent does on its own over time: recurring jobs (every week), work triggered by events, webhooks or watchers, monitoring, or long-running autonomous tasks.',
  build: (request, slots) => ({
    id: 'autonomy-intake',
    label: 'Visible autonomy or schedule intake',
    userSurface: 'Work and schedules workspace',
    userOutcome: 'Create or supervise ongoing work only through visible, cancellable routes.',
    why: 'The request sounds scheduled, recurring, event-triggered, long-running, or autonomous.',
    modelRoute: `autonomy action:"intake" query:${quote(request)} includeParameters:true`,
    inspectRoute: 'autonomy action:"queue"',
    userRoute: 'Agent Workspace -> Work & Approvals',
    requiresConfirmation: slots.changes || slots.starts || slots.controls || slots.reminder,
    missingFields: ['exact cadence/event source when applicable', 'task', 'success criteria'],
    supportingRoutes: [
      'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      'schedule action:"remind" message:"..." scheduleKind:"at|every|cron" scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      'agent_operator_method methodId:"watchers.create" confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Autonomy intake is read-only; schedule, watcher, run-control, and delivery effects stay on the owning confirmed route.',
  }),
};

const localFileRecovery: TaskRouteEntry = {
  id: 'local-file-recovery',
  description: 'Undoing, redoing, restoring or reverting file edits the agent made, from its file snapshots.',
  build: (_request, slots) => ({
    id: 'local-file-recovery',
    label: 'Local file edit recovery',
    userSurface: 'Local file recovery',
    userOutcome: 'Inspect recent Agent file snapshots and apply exactly one confirmed undo or redo when needed.',
    why: 'The request mentions undo, redo, restore, revert, or recovery for file/edit/write/patch changes.',
    modelRoute: 'execution action:"recovery" includeParameters:true',
    inspectRoute: 'execution action:"history" includeParameters:true',
    userRoute: 'Main conversation (confirmed file-recovery route)',
    requiresConfirmation: slots.changes,
    missingFields: ['recovery action when not obvious', 'snapshot target if multiple snapshots are available', 'confirmation before applying undo/redo'],
    supportingRoutes: [
      'execution action:"record" target:"..."',
      'agent_harness mode:"file_recovery" includeParameters:true',
      'agent_harness mode:"run_file_recovery" recoveryAction:"undo|redo" confirm:true explicitUserRequest:"..."',
    ],
    policy: 'Recovery inspection is read-only. Applying an undo or redo snapshot is a single confirmed local file mutation with before/after state tracked by FileUndoManager.',
  }),
};

const interactiveProcess: TaskRouteEntry = {
  id: 'interactive-process-capability',
  description: 'Interactive terminal work: a PTY, typing into a running process through stdin, answering password or sudo prompts, or driving an interactive CLI.',
  build: (_request, slots) => {
    const interactiveEffect = slots.starts || slots.changes;
    return {
      id: 'interactive-process-capability',
      label: 'Interactive process, PTY, stdin, or sudo capability',
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
    };
  },
};

const localBackgroundProcess: TaskRouteEntry = {
  id: 'local-background-process',
  description: 'Running a shell command as a local background process, or checking, polling, reading logs of, waiting on or killing one that is running.',
  build: (_request, slots) => ({
    id: 'local-background-process',
    label: 'Local background process controls',
    userSurface: 'Work and process supervision workspace',
    userOutcome: 'Start or manage long-running local commands through visible process ids, logs, and cancellation routes.',
    why: 'The request mentions terminal background commands, process lifecycle actions, stdin, PTY, or process supervision.',
    modelRoute: 'execution action:"processes" includeParameters:true',
    inspectRoute: 'execution action:"capabilities"',
    userRoute: 'Agent Workspace -> Work & Approvals',
    requiresConfirmation: slots.starts || slots.controls,
    missingFields: slots.starts
      ? ['command', 'working directory when not the current workspace', 'confirmation']
      : slots.controls || slots.existing
        ? ['process id or session id']
        : undefined,
    supportingRoutes: [
      'terminal command:"..." background:true confirm:true explicitUserRequest:"..."',
      'process action:"list"',
      'process action:"poll|log|wait|kill|write" session_id:"..."',
      'process action:"capabilities"',
    ],
    policy: 'Process planning and listing are read-only. Starting commands, waiting, killing, and stdin writes use the first-class terminal/process confirmation boundaries with bounded redacted logs.',
  }),
};

/** Delegated or isolated build work, or local-first execution: one family, the delegated slot picks the variant. */
const buildWork: TaskRouteEntry = {
  id: 'build-work',
  description: 'Software work on code in a repository: building, fixing, implementing, refactoring, testing, linting, reviewing a pull request, running shell commands or editing files, whether done here or delegated.',
  build: (_request, slots) => {
    const delegated = slots.delegated;
    return {
      id: delegated ? 'delegated-build-work' : 'local-first-execution',
      label: delegated ? 'Delegated or isolated build work' : 'Local-first execution and file work',
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
    };
  },
};

export const WORK_ROUTES: readonly TaskRouteEntry[] = [
  researchRunner,
  researchVisualReport,
  deepResearch,
  directSchedule,
  autonomyIntake,
  localFileRecovery,
  interactiveProcess,
  localBackgroundProcess,
  buildWork,
];
