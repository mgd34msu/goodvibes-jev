import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import type { BackgroundProcess, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { interactiveRuntimeCapabilitySummary, interactiveRuntimeParityStatus } from './agent-harness-interactive-runtime-records.ts';
import { DEFAULT_BACKGROUND_TIMEOUT_MS, clampTimeout, processAgeMs, processStatus, resolveBackgroundProcessClass, resolveKillOnTimeout } from './agent-harness-process-timeout-policy.ts';
import type {
  AgentHarnessBackgroundProcessArgs,
  BackgroundProcessLookupSource,
  BackgroundProcessResolution,
  ProcessCapabilityStatus,
} from './agent-harness-background-processes-types.ts';
export type {
  AgentHarnessBackgroundProcessArgs,
  BackgroundProcessResolution,
} from './agent-harness-background-processes-types.ts';

const MAX_LOG_PREVIEW_CHARS = 4_000;
const MAX_COMPACT_LOG_PREVIEW_CHARS = 600;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const PROCESS_PARITY_METHODS = ['terminal(background=true)', 'process(list)', 'process(poll)', 'process(wait)', 'process(log)', 'process(kill)', 'process(write)', 'pty', 'sudo'] as const;
const STDIN_WRITE_METHOD_NAMES = ['write', 'writeInput', 'sendInput', 'writeStdin', 'sendStdin', 'stdinWrite'] as const;
const PTY_METHOD_NAMES = ['spawnPty', 'openPty', 'createPty', 'pty'] as const;
const SENSITIVE_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
  [/(\s--(?:token|password|secret|api-key|api_key)\s+)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>'],
];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function readLimit(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(500, readNumber(value, fallback)));
}

function fieldMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function readField(args: AgentHarnessBackgroundProcessArgs, id: string): string {
  return fieldMap(args.fields)[id] ?? '';
}

function readData(args: AgentHarnessBackgroundProcessArgs): string {
  if (typeof args.data === 'string') return args.data;
  const fromFields = readField(args, 'data');
  return fromFields;
}

function managerFrom(context: CommandContext): ProcessManager | undefined {
  return context.workspace.processManager;
}

interface OperatorContractMethod {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly access?: string;
  readonly scopes?: readonly string[];
  readonly http?: {
    readonly method?: string;
    readonly path?: string;
  };
}

function operatorContractMethods(): readonly OperatorContractMethod[] {
  const methods = getOperatorContract().operator?.methods;
  return Array.isArray(methods)
    ? methods.filter((method): method is OperatorContractMethod => Boolean(method?.id))
    : [];
}

function operatorMethodSearchText(method: OperatorContractMethod): string {
  // EXCLUDES title/description prose: discovery keys off what a method IS
  // (id/route/category/scopes), not how its docs read, SDK 1.4.0's "terminal
  // turn.cancelled event" wording false-matched as a terminal/TTY capability.
  return [
    method.id,
    method.category,
    method.http?.method,
    method.http?.path,
    method.scopes?.join(' '),
  ].filter(Boolean).join('\n').toLowerCase();
}

function matchingOperatorMethodRoutes(tokens: readonly string[]): readonly Record<string, unknown>[] {
  if (tokens.length === 0) return [];
  return operatorContractMethods()
    .filter((method) => {
      const text = operatorMethodSearchText(method);
      // \b-anchored: a raw text.includes(token) false-matches short tokens like 'pty' inside an unrelated word ('empty').
      return tokens.some((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    })
    .map((method) => ({
      methodId: method.id,
      label: method.title ?? method.description ?? method.id,
      category: method.category ?? 'uncategorized',
      effect: method.scopes?.every((scope) => scope.startsWith('read:')) ? 'read-only-network' : method.access === 'admin' ? 'confirmed-admin-connected-host-state' : 'confirmed-connected-host-state',
      route: `${method.http?.method?.toUpperCase() ?? 'GET'} ${method.http?.path ?? '/'}`,
      modelRoute: `agent_operator_method methodId:"${method.id}"`,
    }))
    .sort((left, right) => String(left.methodId).localeCompare(String(right.methodId)))
    .slice(0, 12);
}

function managerMethodNames(manager: ProcessManager | undefined): readonly string[] {
  if (!manager) return [];
  const own = Object.keys(manager);
  const prototype = Object.getPrototypeOf(manager) as Record<string, unknown> | null;
  const protoNames = prototype ? Object.getOwnPropertyNames(prototype) : [];
  return [...new Set([...own, ...protoNames])]
    .filter((name) => name !== 'constructor' && typeof (manager as unknown as Record<string, unknown>)[name] === 'function')
    .sort((left, right) => left.localeCompare(right));
}

function firstManagerFunction(manager: ProcessManager | undefined, names: readonly string[]): ((processId: string, data: string) => unknown) | null {
  if (!manager) return null;
  const record = manager as unknown as Record<string, unknown>;
  for (const name of names) {
    const fn = record[name];
    if (typeof fn === 'function') return fn.bind(manager) as (processId: string, data: string) => unknown;
  }
  return null;
}

function processSubstrateReport(context?: CommandContext): Record<string, unknown> {
  const manager = context ? managerFrom(context) : undefined;
  const methodNames = managerMethodNames(manager);
  const localStdinMethod = STDIN_WRITE_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const localPtyMethod = PTY_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const terminalRoutes = matchingOperatorMethodRoutes(['terminal', 'pty', 'process.write', 'stdin']);
  const sessionInputRoutes = matchingOperatorMethodRoutes(['sessions.inputs']);
  const credentialRoutes = matchingOperatorMethodRoutes(['credential', 'sudo', 'privilege']);
  return {
    localProcessManager: {
      status: manager ? 'available' : 'unavailable',
      methodNames,
      supports: methodNames.filter((name) => ['spawn', 'list', 'getStatus', 'getOutput', 'stop', 'handleCommand', localStdinMethod, localPtyMethod].filter(Boolean).includes(name)),
      stdinWrite: localStdinMethod
        ? { status: 'contract-discovered', method: localStdinMethod, executableByHarness: true }
        : { status: 'blocked-contract-gap', missingAnyOf: STDIN_WRITE_METHOD_NAMES },
      pty: localPtyMethod
        ? { status: 'contract-discovered', method: localPtyMethod, executableByHarness: false }
        : { status: 'blocked-contract-gap', missingAnyOf: PTY_METHOD_NAMES },
    },
    daemonOperatorContract: {
      status: terminalRoutes.length > 0 ? 'terminal-or-pty-methods-discovered' : 'no-published-terminal-or-pty-method',
      terminalOrPtyRoutes: terminalRoutes,
      sessionInputRoutes,
      credentialRoutes,
      policy: 'Session input routes steer GoodVibes sessions; they are not equivalent to writing stdin into a tracked local process.',
    },
  };
}

function redactText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function compactText(value: string, max: number): string {
  return tailText(redactText(value), max);
}

function tailText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(Math.max(0, value.length - max)).trimStart();
}

function outputTail(value: string, max: number): {
  readonly text: string;
  readonly chars: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly omittedChars: number;
} {
  const redacted = redactText(value);
  const text = tailText(redacted, max);
  const omittedChars = Math.max(0, redacted.length - text.length);
  return {
    text,
    chars: redacted.length,
    bytes: Buffer.byteLength(redacted),
    truncated: omittedChars > 0,
    omittedChars,
  };
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactWrittenInputPreview(value: string, data: string): { readonly text: string; readonly redactedInputEcho: boolean } {
  if (!data) return { text: value, redactedInputEcho: false };
  const escaped = JSON.stringify(data).slice(1, -1);
  let text = value;
  let redactedInputEcho = false;
  for (const candidate of [data, escaped]) {
    if (!candidate || !text.includes(candidate)) continue;
    text = text.split(candidate).join('<redacted-input>');
    redactedInputEcho = true;
  }
  return { text, redactedInputEcho };
}

function summarizeWriteResult(value: unknown, data: string): Record<string, unknown> {
  if (typeof value === 'undefined') return { returned: false };
  const redacted = redactText(safeJsonPreview(value));
  const inputRedacted = redactWrittenInputPreview(redacted, data);
  return {
    returned: true,
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    preview: previewHarnessText(inputRedacted.text, 240),
    inputEchoRedacted: inputRedacted.redactedInputEcho,
    policy: 'Result preview is bounded, secret-redacted, and strips exact input echoes.',
  };
}


function routeFor(processId: string, mode: 'background_process' | 'run_background_process', action?: string): string {
  if (mode === 'background_process') return `execution action:"process" processId:"${processId}"`;
  const processAction = action === 'stop' ? 'kill' : action || 'poll';
  const confirmation = ['wait', 'kill', 'stop', 'write', 'start'].includes(processAction) ? ' confirm:true explicitUserRequest:"..."' : '';
  return `process action:"${processAction}" processId:"${processId}"${confirmation}`;
}

function readProcessSessionId(args: AgentHarnessBackgroundProcessArgs): { readonly source: BackgroundProcessLookupSource; readonly input: string } | null {
  const processId = readString(args.processId) || readField(args, 'processId');
  if (processId) return { source: 'processId', input: processId };
  const processSessionId = readString(args.processSessionId) || readField(args, 'processSessionId');
  if (processSessionId) return { source: 'processSessionId', input: processSessionId };
  const sessionId = readString(args.sessionId) || readField(args, 'sessionId');
  if (sessionId) return { source: 'sessionId', input: sessionId };
  const snakeSessionId = readString(args.session_id) || readField(args, 'session_id');
  if (snakeSessionId) return { source: 'session_id', input: snakeSessionId };
  return null;
}

function describeProcessEntry(
  manager: ProcessManager,
  entry: BackgroundProcess,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const output = manager.getOutput(entry.id) ?? { stdout: '', stderr: '' };
  const maxOutputChars = options.includeParameters ? MAX_LOG_PREVIEW_CHARS : MAX_COMPACT_LOG_PREVIEW_CHARS;
  const stdout = outputTail(output.stdout, maxOutputChars);
  const stderr = outputTail(output.stderr, maxOutputChars);
  const includeOutput = options.includeParameters === true || Boolean(stdout.text || stderr.text);
  return {
    processId: entry.id,
    processSessionId: entry.id,
    sessionId: entry.id,
    session_id: entry.id,
    pid: entry.pid,
    status: processStatus(entry),
    done: entry.done,
    exitCode: entry.exitCode,
    ...(entry.timedOut === true ? { timedOut: true } : {}),
    ...(entry.signal ? { signal: entry.signal } : {}),
    command: options.includeParameters ? redactText(entry.cmd) : previewHarnessText(redactText(entry.cmd), 120),
    startedAt: new Date(entry.startTime).toISOString(),
    ageMs: processAgeMs(entry),
    routes: {
      inspect: routeFor(entry.id, 'background_process'),
      poll: routeFor(entry.id, 'run_background_process', 'poll'),
      log: routeFor(entry.id, 'run_background_process', 'log'),
      wait: routeFor(entry.id, 'run_background_process', 'wait'),
      stop: routeFor(entry.id, 'run_background_process', 'stop'),
      visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
      liveTail: `workspace action:"open" surfaceId:"live-tail" target:"${entry.id}"`,
    },
    ...(includeOutput ? {
      output: {
        stdoutTail: stdout.text,
        stderrTail: stderr.text,
        stdoutChars: stdout.chars,
        stderrChars: stderr.chars,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        omittedStdoutChars: stdout.omittedChars,
        omittedStderrChars: stderr.omittedChars,
        maxOutputChars,
        fullOutputIncluded: !stdout.truncated && !stderr.truncated,
        policy: 'Output is bounded; counts are computed after secret-looking text is redacted before model display.',
      },
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

function processSearchText(entry: BackgroundProcess): string {
  return [
    entry.id,
    String(entry.pid),
    entry.cmd,
    processStatus(entry),
  ].join('\n').toLowerCase();
}

function lookupFromArgs(args: AgentHarnessBackgroundProcessArgs): { readonly source: BackgroundProcessLookupSource; readonly input: string } | null {
  const processSession = readProcessSessionId(args);
  if (processSession) return processSession;
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function matchingProcesses(manager: ProcessManager, input: string): readonly BackgroundProcess[] {
  const entries = manager.list()
    .map((entry) => manager.getStatus(entry.id))
    .filter((entry): entry is BackgroundProcess => Boolean(entry));
  const normalized = input.toLowerCase().trim();
  if (!normalized) return entries;
  return entries.filter((entry) => processSearchText(entry).includes(normalized));
}

function candidateProcess(entry: BackgroundProcess): Record<string, unknown> {
  return {
    processId: entry.id,
    processSessionId: entry.id,
    sessionId: entry.id,
    session_id: entry.id,
    pid: entry.pid,
    status: processStatus(entry),
    command: previewHarnessText(redactText(entry.cmd), 96),
  };
}

function processToolParity(context?: CommandContext): readonly Record<string, unknown>[] {
  const substrate = processSubstrateReport(context);
  const interactive = context ? interactiveRuntimeParityStatus(context) : null;
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const daemonContract = substrate.daemonOperatorContract as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  const pty = localProcessManager.pty as Record<string, unknown>;
  const terminalRoutes = Array.isArray(daemonContract.terminalOrPtyRoutes) ? daemonContract.terminalOrPtyRoutes : [];
  const writeStatus: ProcessCapabilityStatus = interactive?.stdinWriteContract ? 'contract-discovered' : stdinWrite.status === 'contract-discovered'
    ? 'contract-discovered'
    : terminalRoutes.some((route) => String((route as Record<string, unknown>).methodId).toLowerCase().includes('write'))
      ? 'contract-discovered'
      : 'blocked-contract-gap';
  const ptyStatus: ProcessCapabilityStatus = interactive?.ptyContract || pty.status === 'contract-discovered' || terminalRoutes.length > 0 ? 'contract-discovered' : 'blocked-contract-gap';
  const sudoStatus: ProcessCapabilityStatus = interactive?.sudoMediationContract ? 'contract-discovered' : 'visible-only';
  return [
    {
      capability: 'terminal(background=true)',
      status: 'supported',
      userOutcome: 'Start one visible tracked local command without blocking the conversation.',
      modelRoute: 'terminal command:"..." background:true confirm:true explicitUserRequest:"..."',
    },
    {
      capability: 'process(list)',
      status: 'supported',
      userOutcome: 'See every tracked local background process from the shared ProcessManager.',
      modelRoute: 'execution action:"processes"',
    },
    {
      capability: 'process(poll)',
      status: 'supported',
      userOutcome: 'Poll one tracked process status without waiting.',
      modelRoute: 'process action:"poll" sessionId:"..."',
    },
    {
      capability: 'process(wait)',
      status: 'supported',
      userOutcome: 'Wait on one tracked process with a bounded timeout.',
      modelRoute: 'process action:"wait" processId:"..." confirm:true explicitUserRequest:"..."',
    },
    {
      capability: 'process(log)',
      status: 'supported',
      userOutcome: 'Read redacted stdout/stderr tails with explicit truncation metadata.',
      modelRoute: 'process action:"log" sessionId:"..."',
    },
    {
      capability: 'process(kill)',
      status: 'supported',
      userOutcome: 'Stop and remove one tracked process from the shared ProcessManager.',
      modelRoute: 'process action:"kill" sessionId:"..." confirm:true explicitUserRequest:"..."',
    },
    {
      capability: 'process(write)',
      status: writeStatus,
      userOutcome: writeStatus === 'contract-discovered'
        ? 'Interactive input has a published contract; Agent requires confirmation and a process id before writing.'
        : 'Interactive input is not exposed because the SDK ProcessManager has no safe stdin handle.',
      modelRoute: 'process action:"write" processId:"..." data:"..." confirm:true explicitUserRequest:"..."',
    },
    {
      capability: 'pty',
      status: ptyStatus,
      userOutcome: ptyStatus === 'contract-discovered'
        ? 'A PTY-like contract is discoverable; Agent still requires an explicit session API before generic PTY spawn is enabled.'
        : 'Interactive CLIs need a published PTY/session API before Agent can make them safe and visible.',
      modelRoute: 'terminal command:"..." background:true pty:true confirm:true explicitUserRequest:"..."',
    },
    {
      capability: 'sudo',
      status: sudoStatus,
      userOutcome: sudoStatus === 'contract-discovered' ? 'A certified daemon mediation route is published for visible credential prompts.' : 'Privilege prompts must stay foreground or use a future safe credential-prompt contract.',
      modelRoute: 'execution action:"route" id:"local-shell-command"',
    },
  ];
}

function capabilities(context?: CommandContext): Record<string, unknown> {
  const sudoPosture = sudoExecutionPosture(context);
  const substrate = processSubstrateReport(context);
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  const pty = localProcessManager.pty as Record<string, unknown>;
  return {
    start: 'terminal command:"..." background:true confirm:true explicitUserRequest:"..."',
    inspect: 'execution action:"processes" or action:"process"',
    wait: 'process action:"wait" processId|sessionId:"..." confirm:true explicitUserRequest:"..."',
    stop: 'process action:"kill" processId|sessionId:"..." confirm:true explicitUserRequest:"..."',
    aliases: {
      actions: {
        poll: 'status',
        kill: 'stop',
        log: 'output',
        write: stdinWrite.status === 'contract-discovered' ? 'confirmed stdin write through discovered ProcessManager method' : 'unsupported until ProcessManager exposes stdin',
      },
      ids: ['processId', 'processSessionId', 'sessionId', 'session_id'],
      userOutcome: 'The harness accepts the process-tool words users expect while returning stable processId/sessionId aliases.',
    },
    parity: processToolParity(context),
    substrate: {
      ...substrate,
      auditedTerms: ['terminal', 'process.write', 'stdin', 'pty', 'sudo', 'sessions.inputs'],
    },
    interactiveRuntime: context ? interactiveRuntimeCapabilitySummary(context) : null,
    pty: {
      status: pty.status === 'contract-discovered' ? 'contract-discovered-but-not-generic-executable' : 'not-yet-supported-in-agent-harness',
      guidance: pty.status === 'contract-discovered'
        ? 'A PTY-like method is discoverable, but Agent needs a typed session contract before generic PTY spawn can be safe.'
        : 'Use foreground exec for noninteractive commands. Interactive PTY needs a published SDK/daemon session API before Agent can expose it safely.',
    },
    stdinWrite: {
      status: stdinWrite.status === 'contract-discovered' ? 'supported-with-confirmation' : 'not-yet-supported-in-agent-harness',
      modelRoute: 'process action:"write" processId:"..." data:"..." confirm:true explicitUserRequest:"..."',
      guidance: stdinWrite.status === 'contract-discovered'
        ? 'The shared ProcessManager exposes a stdin write method. Agent requires confirm:true, explicitUserRequest, one exact process id, and non-empty data.'
        : 'ProcessManager currently tracks output and stop lifecycle; it does not expose a safe stdin write API.',
    },
    sudo: {
      ...sudoPosture,
      guidance: sudoPosture.credentialSignal.guidance,
    },
  };
}

export function backgroundProcessCatalogStatus(context: CommandContext): Record<string, unknown> {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      modes: ['background_processes', 'background_process', 'run_background_process'],
      status: 'unavailable',
      tracked: 0,
      running: 0,
      readOnly: false,
      reason: 'ProcessManager is not wired into this runtime.',
    };
  }
  const entries = matchingProcesses(manager, '');
  return {
    modes: ['background_processes', 'background_process', 'run_background_process'],
    status: 'available',
    tracked: entries.length,
    running: entries.filter((entry) => !entry.done).length,
    completed: entries.filter((entry) => entry.done).length,
    readOnly: false,
  };
}

export function backgroundProcessSummary(context: CommandContext, args: AgentHarnessBackgroundProcessArgs): Record<string, unknown> {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'unavailable',
      processes: [],
      returned: 0,
      total: 0,
      capabilities: capabilities(context),
      policy: 'Background process UX uses the shared GoodVibes ProcessManager when the current runtime wires it in.',
    };
  }
  const query = readString(args.query || args.target);
  const entries = matchingProcesses(manager, query);
  const limit = readLimit(args.limit, 100);
  const processes = entries.slice(0, limit).map((entry) => describeProcessEntry(manager, entry, {
    includeParameters: args.includeParameters === true,
  }));
  return {
    status: 'available',
    summary: {
      tracked: entries.length,
      running: entries.filter((entry) => !entry.done).length,
      completed: entries.filter((entry) => entry.done).length,
      visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
      liveTail: 'workspace action:"open" surfaceId:"live-tail"',
    },
    processes,
    returned: processes.length,
    total: entries.length,
    capabilities: capabilities(context),
    policy: 'List/status/log routes are read-only and bounded. Starting, waiting on, or stopping a background process requires confirm:true and explicitUserRequest.',
  };
}

export function describeBackgroundProcess(context: CommandContext, args: AgentHarnessBackgroundProcessArgs): BackgroundProcessResolution {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'missing_lookup',
      usage: 'Background processes are unavailable because ProcessManager is not wired into this runtime.',
    };
  }
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"process" requires processId, target, or query. Use execution action:"processes" to inspect tracked process ids.',
    };
  }
  const exact = manager.getStatus(lookup.input);
  if (exact) {
    return {
      status: 'found',
      process: describeProcessEntry(manager, exact, {
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'id' },
      }),
    };
  }
  const matches = matchingProcesses(manager, lookup.input);
  if (matches.length === 1) {
    return {
      status: 'found',
      process: describeProcessEntry(manager, matches[0]!, {
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'search' },
      }),
    };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: matches.slice(0, 8).map(candidateProcess),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown background process ${lookup.input}. Use execution action:"processes" to inspect tracked process ids.`,
  };
}

function requireConfirmed(args: AgentHarnessBackgroundProcessArgs, action: string): string | null {
  if (!readString(args.explicitUserRequest)) return `${action} requires explicitUserRequest with the user's exact request or a short faithful summary.`;
  if (args.confirm !== true) return `${action} requires confirm:true after an explicit user request.`;
  return null;
}

function readProcessAction(args: AgentHarnessBackgroundProcessArgs): string {
  const action = (
    readString(args.processAction)
    || readString(args.action)
    || readField(args, 'action')
    || (readString(args.command) || readField(args, 'command') ? 'start' : '')
  ).toLowerCase();
  if (action === 'poll') return 'status';
  if (action === 'kill') return 'stop';
  return action;
}

function readCommand(args: AgentHarnessBackgroundProcessArgs): string {
  return readString(args.command) || readField(args, 'command');
}

function readProcessId(args: AgentHarnessBackgroundProcessArgs): string {
  return readProcessSessionId(args)?.input || readString(args.target);
}

function readCwd(context: CommandContext, args: AgentHarnessBackgroundProcessArgs): string | undefined {
  const raw = readString(args.cwd) || readField(args, 'cwd');
  const shellPaths = context.workspace.shellPaths;
  if (!raw) return shellPaths?.workingDirectory;
  if (!shellPaths) return raw;
  const resolved = shellPaths.resolveWorkspacePath(raw);
  if (!shellPaths.isWithinWorkingDirectory(resolved)) {
    throw new Error('Background process cwd must stay inside the current Agent workspace.');
  }
  return resolved;
}

function looksLikeSudo(command: string): boolean {
  return /(^|[\s;&|])(?:sudo|su|doas|pkexec)\b/.test(command);
}

async function waitForProcess(manager: ProcessManager, processId: string, timeoutMs: number): Promise<BackgroundProcess | undefined> {
  const started = Date.now();
  for (;;) {
    const entry = manager.getStatus(processId);
    if (!entry || entry.done) return entry;
    if (Date.now() - started >= timeoutMs) return entry;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function runBackgroundProcessAction(context: CommandContext, args: AgentHarnessBackgroundProcessArgs): Promise<Record<string, unknown>> {
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'unavailable',
      reason: 'ProcessManager is not wired into this runtime.',
      policy: 'Use foreground exec or connected-host delegation until background process lifecycle is available.',
    };
  }

  if (args.pty === true || readField(args, 'pty').toLowerCase() === 'true') {
    return {
      ...(capabilities(context).pty as Record<string, unknown>),
      status: 'unsupported',
      capability: 'pty',
    };
  }

  const action = readProcessAction(args);
  if (action === 'write') {
    const confirmationError = requireConfirmed(args, 'Background process stdin write');
    if (confirmationError) return { status: 'needs_confirmation', reason: confirmationError, policy: 'Writing stdin to a background process requires confirm:true and explicitUserRequest.' };
    const writeInput = firstManagerFunction(manager, STDIN_WRITE_METHOD_NAMES);
    if (!writeInput) {
      return {
        ...(capabilities(context).stdinWrite as Record<string, unknown>),
        status: 'unsupported',
        capability: 'stdinWrite',
        processId: readProcessId(args) || null,
        dataReceived: readData(args).length > 0,
      };
    }
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process stdin write requires processId.');
    const data = readData(args);
    if (!data) throw new Error('Background process stdin write requires non-empty data.');
    const entry = manager.getStatus(processId);
    if (!entry) {
      return {
        status: 'not_found',
        capability: 'stdinWrite',
        processId,
        policy: 'No tracked process matched that id; no input was written.',
      };
    }
    if (entry.done) {
      return {
        status: 'not_running',
        capability: 'stdinWrite',
        processId,
        policy: 'Input is only written to currently running tracked processes.',
      };
    }
    const result = await writeInput(processId, data);
    return {
      status: 'written',
      capability: 'stdinWrite',
      processId,
      bytes: Buffer.byteLength(data),
      result: summarizeWriteResult(result, data),
      policy: 'Input was written through the shared ProcessManager stdin contract after explicit confirmation. The input data is not echoed in model-visible output.',
    };
  }
  if (action === 'capabilities' || action === 'doctor' || action === 'parity') {
    return {
      status: 'available',
      capabilities: capabilities(context),
      methods: PROCESS_PARITY_METHODS,
      policy: 'This is a read-only process UX contract report. It does not start, stop, or write to any process.',
    };
  }
  if (action === 'start' || action === 'spawn' || action === 'run') {
    const confirmationError = requireConfirmed(args, 'Background process start');
    if (confirmationError) return { status: 'needs_confirmation', reason: confirmationError, policy: 'Starting a background process requires confirm:true and explicitUserRequest.' };
    const command = readCommand(args);
    if (!command) throw new Error('Background process start requires command.');
    if (looksLikeSudo(command)) {
      return {
        status: 'blocked',
        capability: 'sudo',
        reason: 'Background sudo prompts are not exposed by Agent because they can hang or hide privilege escalation.',
        guidance: capabilities(context).sudo,
      };
    }
    const cwd = readCwd(context, args);
    const timeoutMs = clampTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_BACKGROUND_TIMEOUT_MS);
    const processClass = resolveBackgroundProcessClass(args, command);
    const killOnTimeout = resolveKillOnTimeout(args, processClass);
    const result = await manager.spawn(command, cwd, undefined, {
      timeout_ms: timeoutMs,
      sigterm_grace_ms: 5_000,
      kill_on_timeout: killOnTimeout,
    });
    return {
      status: 'started',
      processClass,
      killOnTimeout,
      timeoutBehavior: killOnTimeout
        ? `SIGTERM then SIGKILL after ${timeoutMs}ms.`
        : `Left running past ${timeoutMs}ms; stop it explicitly with process action:"kill".`,
      processId: result.process_id,
      processSessionId: result.process_id,
      sessionId: result.process_id,
      session_id: result.process_id,
      pid: result.pid,
      command: redactText(command),
      cwd,
      timeoutMs,
      routes: {
        inspect: result.process_id ? routeFor(result.process_id, 'background_process') : null,
        poll: result.process_id ? routeFor(result.process_id, 'run_background_process', 'poll') : null,
        log: result.process_id ? routeFor(result.process_id, 'run_background_process', 'log') : null,
        wait: result.process_id ? routeFor(result.process_id, 'run_background_process', 'wait') : null,
        stop: result.process_id ? routeFor(result.process_id, 'run_background_process', 'stop') : null,
        visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
        liveTail: result.process_id ? `workspace action:"open" surfaceId:"live-tail" target:"${result.process_id}"` : null,
      },
      policy: 'Started as a tracked local background process with bounded timeout and visible monitor/live-tail routes.',
    };
  }

  if (action === 'stop' || action === 'kill' || action === 'cancel') {
    const confirmationError = requireConfirmed(args, 'Background process stop');
    if (confirmationError) return { status: 'needs_confirmation', reason: confirmationError, policy: 'Stopping a background process requires confirm:true and explicitUserRequest.' };
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process stop requires processId.');
    const stopped = manager.stop(processId);
    return {
      status: stopped ? 'stopped' : 'not_found',
      processId,
      processSessionId: processId,
      sessionId: processId,
      session_id: processId,
      policy: stopped
        ? 'The process was signaled and removed from the shared ProcessManager.'
        : 'No tracked process matched that id.',
    };
  }

  if (action === 'wait') {
    const confirmationError = requireConfirmed(args, 'Background process wait');
    if (confirmationError) return { status: 'needs_confirmation', reason: confirmationError, policy: 'Waiting on a background process requires confirm:true and explicitUserRequest.' };
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process wait requires processId.');
    const timeoutMs = clampTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_WAIT_TIMEOUT_MS);
    const entry = await waitForProcess(manager, processId, timeoutMs);
    return {
      status: entry?.done ? 'completed' : entry ? 'still_running' : 'not_found',
      processId,
      processSessionId: processId,
      sessionId: processId,
      session_id: processId,
      timeoutMs,
      ...(entry ? { process: describeProcessEntry(manager, entry, { includeParameters: true }) } : {}),
      policy: 'Wait observes the tracked process and does not send input or signals.',
    };
  }

  if (action === 'list') return backgroundProcessSummary(context, args);
  if (action === 'status' || action === 'log' || action === 'output') {
    const resolved = describeBackgroundProcess(context, args);
    if (resolved.status === 'found') return resolved.process;
    return {
      status: resolved.status,
      ...(resolved.status === 'ambiguous' ? { input: resolved.input, candidates: resolved.candidates } : { usage: resolved.usage }),
    };
  }

  throw new Error('run_background_process requires processAction start, stop/kill, wait, list, status/poll, log/output, write, or capabilities.');
}
