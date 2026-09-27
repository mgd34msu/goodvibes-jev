/**
 * `routing.task-route.slots`: what a user task asks for, beyond which route
 * handles it. These questions replace the agent's per-route effect word
 * lists (writeLike, providerEffect, runnerEffect, openPicker, lifecycle and
 * the rest) and its closed-vocabulary lookups (the Personal Ops lane, the
 * channel task, the security policy tool target). Every route reads the same
 * few flags, so each question is asked once per plan, in one request.
 *
 * State: `{ request }`, the task as the user wrote it.
 *
 * Bands: low stakes. The readings only choose a route variant, whether the
 * plan says an effect needs confirmation, and which fields it lists as
 * missing; the plan is read-only and every effect it points to keeps its own
 * confirmation gate.
 *
 * How readings become slots (readSlots):
 * - An effect flag (changes, starts, opensUi, controls, freshRead) is set
 *   unless the reading is a clear no: an unsure reading keeps the
 *   confirmation boundary in the plan.
 * - A variant flag (existing, reminder, delegated, device, evidence,
 *   instructionFiles) is set only on a yes.
 * - A choice is used unless it escalates; an escalated lane or policy target
 *   is none, an escalated channel task is the plain readiness task.
 * - A named id (routing.task-route.named-id) is used only when the selection
 *   chose it without escalating; otherwise the route keeps its generic string.
 */
import { defineBattery, oneOf, STAKES_BANDS, yesNo, type JudgmentPort, type Selection, type YesNoReading } from '@goodvibes-jev/judgment';
import { NAMED_ID_KINDS, namedIdCandidates, taskRouteNamedId, type NamedIdKind, type NamedIdSources } from './named-ids.js';
import type { ChannelTask, PersonalOpsLaneId, TaskRouteSlots } from './types.js';

const LOW = STAKES_BANDS.low;

export const PERSONAL_OPS_LANES = {
  inbox: 'Email: the inbox, mail, messages, threads or replies',
  calendar: 'The calendar: agenda, meetings, events, availability or RSVPs',
  notes: 'Notes: jotting something down or a scratchpad',
  tasks: 'Tasks, to-dos or work items',
  reminders: 'Reminders or follow-ups',
  routines: 'Routines, checklists or repeatable personal procedures',
  delivery: 'Delivering or sending a summary or briefing somewhere',
  none: 'None of these',
} as const;

export const CHANNEL_TASKS = {
  receipts: 'Review the history or receipts of messages already delivered',
  triage: 'Troubleshoot channel problems: failed or pending deliveries, retries, errors or blockers',
  setup: 'Set up, connect, configure, enable or repair a channel',
  send: 'Send a message, notification or test ping through a channel',
  status: 'Check whether channels are configured and ready, or anything else about channels',
} as const satisfies Record<ChannelTask, string>;

/** The tool targets `security action:"explain"` accepts (the agent's securityPolicyToolTarget set). */
export const POLICY_TARGETS = {
  agent_harness: 'The agent_harness tool',
  settings: 'Settings or configuration',
  terminal: 'Terminal or shell commands',
  process: 'Background or running processes',
  exec: 'Code or script execution (exec)',
  channels: 'External messaging channels',
  schedule: 'Schedules or reminders',
  personal_ops: 'Personal Ops: email or calendar actions',
  models: 'Models or model providers',
  memory: 'Memory',
  computer: 'The browser, screenshots or computer use',
  device: 'Devices, voice or text-to-speech',
  workspace: 'Workspace actions',
  host: 'The connected host or daemon',
  none: 'No particular tool or area',
} as const;

export const taskRouteSlots = defineBattery({
  name: 'routing.task-route.slots',
  version: 2,
  description: 'What a user task asks for beyond its route: which effects it wants, which variant of a route applies, and which lane, channel task or tool it concerns.',
  accuracyFloor: 0.9,
  items: {
    changes: yesNo(
      'Does `request` ask for something to be changed, created, saved, connected, set up, imported, exported, sent, submitted, bought, deleted or undone, or for a new option to be picked for the assistant to use? Asking only to look, check, list, search, read, download, explain, recommend which option is best, draft without sending, or plan does not count.',
      LOW.yesNo,
    ),
    starts: yesNo(
      'Does `request` ask the assistant to start, run, launch or carry out something new now, such as a command, process, job, research run, capture, transcription or comparison? Asking about something, checking whether it is ready, changing a setting, or stopping, killing, pausing or checking on something already running does not count.',
      LOW.yesNo,
    ),
    opensUi: yesNo(
      'Does `request` ask to open, launch or render something visible on the user\'s screen, such as a browser, dashboard, PWA, window, picker or rendered report? Listing or summarizing information in a reply does not count.',
      LOW.yesNo,
    ),
    controls: yesNo(
      'Does `request` ask to act on a schedule, job or process that already exists: pause, resume, run it now, edit, cancel, delete, enable, disable, stop or kill it, wait on it, or send it input?',
      LOW.yesNo,
    ),
    existing: yesNo(
      'Does `request` refer to a particular process, job or schedule that is already running or already set up, to check on it or act on it (for example poll its status, read its logs or stop it)?',
      LOW.yesNo,
    ),
    freshRead: yesNo(
      'Does `request` ask to fetch fresh, live data from a personal email or calendar account now: refresh, sync, pull the latest or unread mail, or upcoming events? Working with saved items, summarizing, triaging or replying does not count.',
      LOW.yesNo,
    ),
    reminder: yesNo('Does `request` ask for a reminder: for the user to be reminded of something at a later time?', LOW.yesNo),
    delegated: yesNo(
      'Does `request` ask for work to be delegated or run apart from this conversation: in parallel, by subagents or other agents, in an isolated worktree or sandbox, in the background, or on a remote machine?',
      LOW.yesNo,
    ),
    device: yesNo(
      'Is `request` about a device capability (a phone or mobile device, a camera, a microphone, voice or text-to-speech) rather than a browser, screen or desktop capability?',
      LOW.yesNo,
    ),
    evidence: yesNo(
      'Is `request` about packaged release evidence (evidence or audit artifacts, the verification ledger, package evidence files) rather than the release readiness inventory, release gates or quality dimensions?',
      LOW.yesNo,
    ),
    instructionFiles: yesNo(
      'Is `request` about project instruction files the assistant reads (AGENTS.md, CLAUDE.md, .hermes.md, .cursorrules or other project context) rather than the assistant\'s own personality, tone, style or persona (VIBE.md, SOUL.md)?',
      LOW.yesNo,
    ),
    lane: oneOf('Which part of the user\'s personal information does `request` concern? If it concerns several, choose the one listed first.', PERSONAL_OPS_LANES, LOW.confidence),
    channelTask: oneOf('What does `request` ask about external messaging channels or notifications?', CHANNEL_TASKS, LOW.confidence),
    policyTarget: oneOf(
      '`request` asks whether an action is or was allowed, blocked or held for confirmation. Which tool or area is that action in?',
      POLICY_TARGETS,
      LOW.confidence,
    ),
  },
  fixtures: [
    // Effects.
    { name: 'change the theme', state: { request: 'change the theme setting' }, expect: { changes: 'yes', starts: 'no', opensUi: 'no' } },
    { name: 'read a preference', state: { request: 'what is my current auto-approve preference?' }, expect: { changes: 'no' } },
    { name: 'best route is a question', state: { request: 'choose the best model route for long context coding' }, expect: { changes: 'no', starts: 'no' } },
    { name: 'pick a tts provider', state: { request: 'choose a TTS provider for spoken responses' }, expect: { changes: 'yes' } },
    { name: 'connect a provider', state: { request: 'connect OpenRouter subscription' }, expect: { changes: 'yes' } },
    { name: 'undo an edit', state: { request: 'undo the last file edit' }, expect: { changes: 'yes' } },
    { name: 'submit a form', state: { request: 'fill out the contact form on the website and submit it' }, expect: { changes: 'yes' } },
    { name: 'download is not a change', state: { request: 'log in to my account on example.com and download the invoice' }, expect: { changes: 'no' } },
    { name: 'export a bundle', state: { request: 'export a support bundle for diagnostics' }, expect: { changes: 'yes' } },
    { name: 'run tests in background', state: { request: 'run pytest -v tests/ in background' }, expect: { starts: 'yes', delegated: 'yes', controls: 'no', existing: 'no' } },
    { name: 'runner readiness', state: { request: 'check browser-backed research runner readiness' }, expect: { starts: 'no', opensUi: 'no' } },
    { name: 'start research', state: { request: 'start a deep research run on the market map and cite sources' }, expect: { starts: 'yes' } },
    { name: 'take a screenshot', state: { request: 'take a screenshot of the screen' }, expect: { starts: 'yes' } },
    { name: 'open the dashboard', state: { request: 'open the browser dashboard' }, expect: { opensUi: 'yes', changes: 'no' } },
    { name: 'render a report', state: { request: 'render the visual research report in the browser' }, expect: { opensUi: 'yes' } },
    { name: 'show permissions', state: { request: 'show current permissions and approval mode' }, expect: { opensUi: 'no', changes: 'no' } },
    // Existing processes and schedules.
    { name: 'kill a server', state: { request: 'kill the background dev server process' }, expect: { controls: 'yes', existing: 'yes', starts: 'no' } },
    { name: 'read process logs', state: { request: 'show the logs of the build process that is running' }, expect: { existing: 'yes', controls: 'no' } },
    { name: 'pause a schedule', state: { request: 'pause the nightly backup schedule' }, expect: { controls: 'yes', existing: 'yes', reminder: 'no' } },
    { name: 'new schedule', state: { request: 'schedule a nightly database backup at 2am' }, expect: { reminder: 'no', changes: 'yes', controls: 'no', existing: 'no' } },
    { name: 'reminder', state: { request: 'remind me tomorrow to stretch' }, expect: { reminder: 'yes', controls: 'no' } },
    // Personal Ops.
    { name: 'triage and draft', state: { request: 'triage my inbox and draft replies' }, expect: { changes: 'no', freshRead: 'no', lane: 'inbox' } },
    { name: 'refresh gmail', state: { request: 'refresh my Gmail inbox' }, expect: { freshRead: 'yes', lane: 'inbox' } },
    { name: 'upcoming events live', state: { request: 'pull my upcoming calendar events from the account now' }, expect: { freshRead: 'yes', lane: 'calendar' } },
    { name: 'saved review queue', state: { request: 'show my saved inbox review queue' }, expect: { freshRead: 'no', lane: 'inbox' } },
    { name: 'calendar brief', state: { request: 'brief my calendar for today' }, expect: { lane: 'calendar', changes: 'no' } },
    { name: 'add a note', state: { request: 'add a note that the plumber comes on Tuesday' }, expect: { lane: 'notes', changes: 'yes' } },
    { name: 'open tasks', state: { request: 'show my open to-do tasks' }, expect: { lane: 'tasks' } },
    { name: 'follow-ups', state: { request: 'list the follow-ups I asked to be reminded about' }, expect: { lane: 'reminders' } },
    { name: 'morning routine', state: { request: 'walk me through my morning routine checklist' }, expect: { lane: 'routines' } },
    { name: 'deliver the briefing', state: { request: 'deliver my daily summary to my phone' }, expect: { lane: 'delivery' } },
    { name: 'personal ops status', state: { request: 'is personal ops ready to use?' }, expect: { lane: 'none' } },
    // Variants.
    { name: 'parallel fix', state: { request: 'fix the failing tests in parallel' }, expect: { delegated: 'yes' } },
    { name: 'local fix', state: { request: 'Fix the failing tests in this repo.' }, expect: { delegated: 'no' } },
    { name: 'subagent worktree', state: { request: 'hand the refactor to a subagent in an isolated worktree' }, expect: { delegated: 'yes' } },
    { name: 'phone camera', state: { request: 'can you use my phone camera and microphone?' }, expect: { device: 'yes' } },
    { name: 'desktop capabilities', state: { request: 'what desktop control and browser capabilities do you have?' }, expect: { device: 'no' } },
    { name: 'release evidence', state: { request: 'inspect release evidence artifact live verification' }, expect: { evidence: 'yes' } },
    { name: 'release readiness', state: { request: 'show release readiness inventory' }, expect: { evidence: 'no' } },
    { name: 'agents file', state: { request: 'show the AGENTS.md project instructions you loaded' }, expect: { instructionFiles: 'yes' } },
    { name: 'personality', state: { request: 'make your personality more concise in VIBE.md' }, expect: { instructionFiles: 'no', changes: 'yes' } },
    // Channels.
    { name: 'delivery receipts', state: { request: 'show recent delivery receipts' }, expect: { channelTask: 'receipts' } },
    { name: 'failed retries', state: { request: 'triage failed Discord delivery retries' }, expect: { channelTask: 'triage' } },
    { name: 'slack setup', state: { request: 'set up Slack notifications' }, expect: { channelTask: 'setup', changes: 'yes' } },
    { name: 'telegram send', state: { request: 'send message to Telegram' }, expect: { channelTask: 'send', changes: 'yes' } },
    { name: 'channels configured', state: { request: 'which messaging channels are configured?' }, expect: { channelTask: 'status', changes: 'no' } },
    // Policy targets.
    { name: 'harness target', state: { request: 'can you run agent_harness mode run_workspace_action without asking me?' }, expect: { policyTarget: 'agent_harness' } },
    { name: 'settings target', state: { request: 'Why would settings action:set need confirmation?' }, expect: { policyTarget: 'settings' } },
    { name: 'terminal target', state: { request: 'why was that terminal command blocked' }, expect: { policyTarget: 'terminal' } },
    { name: 'process target', state: { request: 'why was killing the background process denied?' }, expect: { policyTarget: 'process' } },
    { name: 'exec target', state: { request: 'am I allowed to exec a python script?' }, expect: { policyTarget: 'exec' } },
    { name: 'channels target', state: { request: 'why would posting to a channel need approval?' }, expect: { policyTarget: 'channels' } },
    { name: 'schedule target', state: { request: 'why was creating that schedule blocked?' }, expect: { policyTarget: 'schedule' } },
    { name: 'personal ops target', state: { request: 'why does archiving an email in personal ops need confirmation?' }, expect: { policyTarget: 'personal_ops' } },
    { name: 'models target', state: { request: 'would switching the default model be blocked?' }, expect: { policyTarget: 'models' } },
    { name: 'memory target', state: { request: 'why was the memory write denied?' }, expect: { policyTarget: 'memory' } },
    { name: 'computer target', state: { request: 'why was the screenshot blocked?' }, expect: { policyTarget: 'computer' } },
    { name: 'device target', state: { request: 'why does text-to-speech playback need confirmation?' }, expect: { policyTarget: 'device' } },
    { name: 'workspace target', state: { request: 'why was that workspace action denied?' }, expect: { policyTarget: 'workspace' } },
    { name: 'host target', state: { request: 'would restarting the daemon be blocked?' }, expect: { policyTarget: 'host' } },
    { name: 'no target', state: { request: 'why was that blocked?' }, expect: { policyTarget: 'none' } },
  ],
});

type SlotReadings = Awaited<ReturnType<typeof taskRouteSlots.run>>['readings'];

/** An effect flag: set unless the reading is a clear no, so an unsure reading keeps the confirmation boundary. */
const effect = (reading: YesNoReading): boolean => reading.verdict !== 'no';
/** A variant flag: set only on a yes. */
const variant = (reading: YesNoReading): boolean => reading.verdict === 'yes';

/** The named id a selection settled on, or null when none was chosen or the reading escalated. */
export const namedIdFrom = (selection: Selection): string | null =>
  selection.chosen !== undefined && selection.outcome !== 'escalate' ? selection.chosen : null;

/** The slots, composed from the battery's readings and the named-id selections (a kind with no listing has none). */
export function composeSlots(readings: SlotReadings, named: Readonly<Partial<Record<NamedIdKind, Selection>>>): TaskRouteSlots {
  const lane = readings.lane.outcome === 'escalate' || readings.lane.choice === 'none' ? null : (readings.lane.choice as PersonalOpsLaneId);
  const policyTarget = readings.policyTarget.outcome === 'escalate' || readings.policyTarget.choice === 'none' ? null : readings.policyTarget.choice;
  return {
    changes: effect(readings.changes),
    starts: effect(readings.starts),
    opensUi: effect(readings.opensUi),
    controls: effect(readings.controls),
    freshRead: effect(readings.freshRead),
    existing: variant(readings.existing),
    reminder: variant(readings.reminder),
    delegated: variant(readings.delegated),
    device: variant(readings.device),
    evidence: variant(readings.evidence),
    instructionFiles: variant(readings.instructionFiles),
    lane,
    channelTask: readings.channelTask.outcome === 'escalate' ? 'status' : readings.channelTask.choice,
    policyTarget,
    modelProvider: named.modelProvider ? namedIdFrom(named.modelProvider) : null,
    memoryProvider: named.memoryProvider ? namedIdFrom(named.memoryProvider) : null,
    channelTarget: named.channelTarget ? namedIdFrom(named.channelTarget) : null,
  };
}

export interface SlotRun {
  readonly slots: TaskRouteSlots;
  recordAction(action: string): void;
}

/**
 * Reads a request's slots: the battery and one named-id selection per kind
 * whose live listing is non-empty, asked concurrently.
 */
export async function readSlots(
  port: JudgmentPort,
  request: string,
  options: { readonly site: string; readonly signal?: AbortSignal; readonly namedIds?: NamedIdSources | undefined },
): Promise<SlotRun> {
  const call = { site: options.site, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const listed = (Object.keys(NAMED_ID_KINDS) as NamedIdKind[])
    .map((kind) => ({ kind, ids: options.namedIds?.[kind]?.() ?? [] }))
    .filter(({ ids }) => ids.length > 0);
  const [run, selections] = await Promise.all([
    taskRouteSlots.run(port, { request }, call),
    Promise.all(listed.map(({ kind, ids }) =>
      taskRouteNamedId.select(port, { request, kind: NAMED_ID_KINDS[kind] }, namedIdCandidates(ids), call),
    )),
  ]);
  const named = Object.fromEntries(listed.map(({ kind }, index) => [kind, selections[index]!])) as Partial<Record<NamedIdKind, Selection>>;
  return { slots: composeSlots(run.readings, named), recordAction: run.recordAction };
}
