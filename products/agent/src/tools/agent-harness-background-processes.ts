import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { realpathSync } from 'node:fs';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';
import { captureCatalogData, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { processClassificationOptions, spawnClassifiedBackgroundProcess } from './agent-harness-process-launch.ts';
import type { ProcessClassificationOptions } from './agent-harness-process-classification.ts';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import type { BackgroundProcess, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { acquireInteractiveRuntimeSnapshot, type InteractiveRuntimeParity } from './agent-harness-interactive-runtime-records.ts';
import { DEFAULT_BACKGROUND_TIMEOUT_MS, clampTimeout, processAgeMs, processStatus } from './agent-harness-process-timeout-policy.ts';
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
const STDIN_WRITE_METHOD_NAMES = ['writeInput'] as const;
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

function routeFor(processId: string, mode: 'background_process' | 'run_background_process', action?: string): string {
  if (mode === 'background_process') return `execution action:"process" processId:"${processId}"`;
  const processAction = action === 'stop' ? 'kill' : action || 'poll';
  return `process action:"${processAction}" processId:"${processId}"`;
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

function trackedProcesses(manager: ProcessManager): readonly BackgroundProcess[] {
  return manager.list().flatMap((entry) => {
    const current = manager.getStatus(entry.id);
    return current ? [current] : [];
  });
}

function lookupFromArgs(args: AgentHarnessBackgroundProcessArgs): { readonly source: BackgroundProcessLookupSource; readonly input: string } | null {
  const processSession = readProcessSessionId(args);
  if (processSession) return processSession;
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function processCatalogEntry(entry: BackgroundProcess) {
  return { id: entry.id, pid: entry.pid, cmd: entry.cmd, status: processStatus(entry), done: entry.done,
    startedAt: new Date(entry.startTime).toISOString(), exitCode: entry.exitCode, timedOut: entry.timedOut, signal: entry.signal };
}

function retainProcessSources(context: CommandContext, manager: ProcessManager, entries: readonly ReturnType<typeof processCatalogEntry>[], options: CatalogRankingOptions, exactId?: string) {
  const revision = JSON.stringify(entries);
  const list = manager.list, getStatus = manager.getStatus, getOutput = manager.getOutput;
  const assertSourcesCurrent = () => {
    options.signal?.throwIfAborted();
    if (managerFrom(context) !== manager || manager.list !== list || manager.getStatus !== getStatus || manager.getOutput !== getOutput) throw new ToolInputProjectionError('stale');
    const exact = exactId === undefined ? undefined : manager.getStatus(exactId);
    const current = exactId === undefined ? trackedProcesses(manager) : exact ? [exact] : [];
    if (JSON.stringify(captureCatalogData(current.map(processCatalogEntry))) !== revision) throw new ToolInputProjectionError('stale');
  };
  options.retainCurrent?.(assertSourcesCurrent, exactId === undefined ? 'agent.harness.background-processes.sources' : `agent.harness.background-processes.source:${exactId}`);
  return assertSourcesCurrent;
}

async function matchingProcesses(context: CommandContext, manager: ProcessManager, input: string, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const entries = captureCatalogData(trackedProcesses(manager).map(processCatalogEntry));
  const assertSourcesCurrent = retainProcessSources(context, manager, entries, options);
  const assertCurrent = () => { options.assertCurrent?.(); assertSourcesCurrent(); };
  assertCurrent();
  if (!input) return { all: entries, matches: entries.map((entry) => ({ entry, judgment: undefined })), judgments: [], assertCurrent };
  const ranked = await rankHarnessCatalog(entries, input, (entry) => ({ id: entry.id,
    description: `${entry.id}\n${entry.pid}\n${entry.cmd}\n${entry.status}`, evidence: entry }),
    'agent.harness.background-processes', { ...options, requirePreservedSource: true, assertCurrent });
  assertCurrent();
  return { ...ranked, all: entries, assertCurrent };
}

function processToolParity(context: CommandContext | undefined, interactive: InteractiveRuntimeParity | null): readonly Record<string, unknown>[] {
  const substrate = processSubstrateReport(context);
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const daemonContract = substrate.daemonOperatorContract as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  const pty = localProcessManager.pty as Record<string, unknown>;
  const terminalRoutes = Array.isArray(daemonContract.terminalOrPtyRoutes) ? daemonContract.terminalOrPtyRoutes : [];
  const writeStatus: ProcessCapabilityStatus = stdinWrite.status === 'contract-discovered'
    ? 'supported'
    : interactive?.stdinWriteContract ? 'contract-discovered'
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
      modelRoute: 'terminal command:"..." background:true',
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
      modelRoute: 'process action:"wait" processId:"..."',
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
      modelRoute: 'process action:"kill" sessionId:"..."',
    },
    {
      capability: 'process(write)',
      status: writeStatus,
      userOutcome: writeStatus === 'supported'
        ? 'Write to a running tracked native stdin pipe under current recorded effect admission.'
        : 'Input requires the local guarded ProcessManager writeInput contract.',
      modelRoute: 'process action:"write" processId:"..." data:"..."',
    },
    {
      capability: 'pty',
      status: ptyStatus,
      userOutcome: ptyStatus === 'contract-discovered'
        ? 'A PTY-like contract is discoverable; Agent still requires an explicit session API before generic PTY spawn is enabled.'
        : 'Interactive CLIs need a published PTY/session API before Agent can make them safe and visible.',
      modelRoute: 'terminal command:"..." background:true pty:true',
    },
    {
      capability: 'sudo',
      status: sudoStatus,
      userOutcome: sudoStatus === 'contract-discovered' ? 'A certified daemon mediation route is published for visible credential prompts.' : 'Privilege prompts must stay foreground or use a future safe credential-prompt contract.',
      modelRoute: 'execution action:"route" id:"local-shell-command"',
    },
  ];
}

async function capabilities(context?: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const snapshot = context ? await acquireInteractiveRuntimeSnapshot(context, options) : null;
  snapshot?.assertCurrent();
  const sudoPosture = sudoExecutionPosture(context);
  const substrate = processSubstrateReport(context);
  const localProcessManager = substrate.localProcessManager as Record<string, unknown>;
  const stdinWrite = localProcessManager.stdinWrite as Record<string, unknown>;
  const pty = localProcessManager.pty as Record<string, unknown>;
  return {
    start: 'terminal command:"..." background:true',
    inspect: 'execution action:"processes" or action:"process"',
    wait: 'process action:"wait" processId|sessionId:"..."',
    stop: 'process action:"kill" processId|sessionId:"..."',
    aliases: {
      actions: {
        poll: 'status',
        kill: 'stop',
        log: 'output',
        write: 'writeInput on a running tracked native stdin pipe',
      },
      ids: ['processId', 'processSessionId', 'sessionId', 'session_id'],
      userOutcome: 'The harness accepts the process-tool words users expect while returning stable processId/sessionId aliases.',
    },
    parity: processToolParity(context, snapshot?.parityStatus ?? null),
    substrate: {
      ...substrate,
      auditedTerms: ['terminal', 'process.write', 'stdin', 'pty', 'sudo', 'sessions.inputs'],
    },
    interactiveRuntime: snapshot?.capabilitySummary ?? null,
    pty: {
      status: pty.status === 'contract-discovered' ? 'contract-discovered-but-not-generic-executable' : 'not-yet-supported-in-agent-harness',
      guidance: pty.status === 'contract-discovered'
        ? 'A PTY-like method is discoverable, but Agent needs a typed session contract before generic PTY spawn can be safe.'
        : 'Use foreground exec for noninteractive commands. Interactive PTY needs a published SDK/daemon session API before Agent can expose it safely.',
    },
    stdinWrite: {
      status: stdinWrite.status === 'contract-discovered' ? 'supported' : 'unavailable',
      modelRoute: 'process action:"write" processId:"..." data:"..."',
      guidance: stdinWrite.status === 'contract-discovered'
        ? 'Tracked launches open a native stdin pipe. Writes require current recorded admission and retain the exact process until the SDK write and flush finish.'
        : 'The local guarded ProcessManager writeInput contract is unavailable.',
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
  const entries = trackedProcesses(manager);
  return {
    modes: ['background_processes', 'background_process', 'run_background_process'],
    status: 'available',
    tracked: entries.length,
    running: entries.filter((entry) => !entry.done).length,
    completed: entries.filter((entry) => entry.done).length,
    readOnly: false,
  };
}

export async function backgroundProcessSummary(context: CommandContext, args: AgentHarnessBackgroundProcessArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const manager = managerFrom(context);
  if (!manager) {
    return {
      status: 'unavailable',
      processes: [],
      returned: 0,
      total: 0,
      capabilities: await capabilities(context, options),
      policy: 'Background process UX uses the shared GoodVibes ProcessManager when the current runtime wires it in.',
    };
  }
  const query = readString(args.query || args.target);
  const selected = await matchingProcesses(context, manager, query, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const entries = selected.matches;
  const all = selected.all;
  const limit = readLimit(args.limit, 100);
  const processes = entries.slice(0, limit).map(({ entry, judgment }) => {
    const current = manager.getStatus(entry.id);
    if (!current) throw new ToolInputProjectionError('stale');
    return { ...describeProcessEntry(manager, current, { includeParameters: args.includeParameters === true }), ...(judgment ? { judgment } : {}) };
  });
  const processCapabilities = await capabilities(context, { ...options, assertCurrent: selected.assertCurrent });
  selected.assertCurrent();
  return {
    status: 'available',
    summary: {
      tracked: all.length,
      running: all.filter((entry) => !entry.done).length,
      completed: all.filter((entry) => entry.done).length,
      visibleMonitor: 'workspace action:"open" surfaceId:"process-monitor"',
      liveTail: 'workspace action:"open" surfaceId:"live-tail"',
    },
    processes,
    judgments: selected.judgments,
    returned: processes.length,
    total: all.length,
    capabilities: processCapabilities,
    policy: 'List/status/log/wait routes are read-only and bounded. Starting or stopping a background process requires current recorded effect admission.',
  };
}

export async function describeBackgroundProcess(context: CommandContext, args: AgentHarnessBackgroundProcessArgs, options: CatalogRankingOptions = {}): Promise<BackgroundProcessResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
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
    retainProcessSources(context, manager, captureCatalogData([processCatalogEntry(exact)]), options, exact.id)();
    return {
      status: 'found',
      process: describeProcessEntry(manager, exact, {
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'id' },
      }),
    };
  }
  const selected = lookup.source === 'target' || lookup.source === 'query'
    ? await matchingProcesses(context, manager, lookup.input, options) : { matches: [], judgments: [] };
  const matches = selected.matches;
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') {
    const current = manager.getStatus(matches[0]!.entry.id);
    if (!current) throw new ToolInputProjectionError('stale');
    return {
      status: 'found',
      process: { ...describeProcessEntry(manager, current, {
        includeParameters: true,
        lookup: { ...lookup, resolvedBy: 'search' },
      }), judgment: matches[0]!.judgment },
    };
  }
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: matches.slice(0, 8).map(({ entry, judgment }) => ({ processId: entry.id, processSessionId: entry.id,
        sessionId: entry.id, session_id: entry.id, pid: entry.pid, status: entry.status,
        command: previewHarnessText(redactText(entry.cmd), 96), judgment })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown background process ${lookup.input}. Use execution action:"processes" to inspect tracked process ids.`,
  };
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
  if (!shellPaths?.workingDirectory) throw new ToolInputProjectionError('held');
  return realpathSync(resolveAndValidatePath(raw || '.', shellPaths.workingDirectory));
}

function looksLikeSudo(command: string): boolean {
  return /(^|[\s;&|])(?:sudo|su|doas|pkexec)\b/.test(command);
}

async function waitForProcess(manager: ProcessManager, processId: string, timeoutMs: number, options: CatalogRankingOptions): Promise<BackgroundProcess | undefined> {
  const started = Date.now();
  for (;;) {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const entry = manager.getStatus(processId);
    if (!entry || entry.done) return entry;
    if (timeoutMs > 0 && Date.now() - started >= timeoutMs) return entry;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function runBackgroundProcessAction(context: CommandContext, args: AgentHarnessBackgroundProcessArgs,
  options: ProcessClassificationOptions & CatalogRankingOptions = {}, originalArgs?: Record<string, unknown>, executionOptions?: Parameters<Tool['execute']>[1],
): Promise<Record<string, unknown>> {
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
      ...((await capabilities(context, options)).pty as Record<string, unknown>),
      status: 'unsupported',
      capability: 'pty',
    };
  }

  const action = readProcessAction(args);
  const assertEffect = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (!originalArgs || !harnessCatalogInvocationAuthority(originalArgs, executionOptions, 'write')) throw new ToolInputProjectionError('held');
    if (managerFrom(context) !== manager) throw new ToolInputProjectionError('held');
  };
  if (action === 'write') {
    assertEffect();
    const processId = readProcessId(args), data = readData(args);
    if (!processId) throw new Error('Background process input requires processId.');
    if (!data) throw new Error('Background process input requires nonempty data.');
    const getStatus = manager.getStatus, writeInput = manager.writeInput;
    const entry = getStatus.call(manager, processId);
    if (!entry || entry.done) throw new ToolInputProjectionError('held');
    const { id, pid, cmd, startTime } = entry;
    const assertCurrent = () => {
      assertEffect();
      if (manager.getStatus !== getStatus || manager.writeInput !== writeInput
        || getStatus.call(manager, processId) !== entry || entry.id !== id || id !== processId
        || entry.pid !== pid || entry.cmd !== cmd || entry.startTime !== startTime || entry.done) {
        throw new ToolInputProjectionError('held');
      }
    };
    assertCurrent();
    const bytesWritten = await writeInput.call(manager, processId, data, { signal: options.signal, assertCurrent });
    assertCurrent();
    return { status: 'written', processId, processSessionId: processId, sessionId: processId, session_id: processId,
      bytesWritten, policy: 'Input was written and flushed to the captured native stdin pipe. Bytes already handed to the child cannot be recalled.' };
  }
  if (action === 'capabilities' || action === 'doctor' || action === 'parity') {
    return {
      status: 'available',
      capabilities: await capabilities(context, options),
      methods: PROCESS_PARITY_METHODS,
      policy: 'This is a read-only process UX contract report. It does not start, stop, or write to any process.',
    };
  }
  if (action === 'start' || action === 'spawn' || action === 'run') {
    assertEffect();
    args = snapshotJudgmentInput(args) as AgentHarnessBackgroundProcessArgs;
    const current = processClassificationOptions(context), supplied = options;
    const command = readCommand(args);
    if (!command) throw new Error('Background process start requires command.');
    if (looksLikeSudo(command)) {
      return {
        status: 'blocked',
        capability: 'sudo',
        reason: 'Background sudo prompts are not exposed by Agent because they can hang or hide privilege escalation.',
        guidance: (await capabilities(context, options)).sudo,
      };
    }
    const cwd = readCwd(context, args);
    const root = context.workspace.shellPaths?.workingDirectory;
    if (!root) throw new ToolInputProjectionError('held');
    const physicalRoot = realpathSync(root);
    const launchOptions = { ...supplied, assertCurrent: () => {
      assertEffect(); current.assertCurrent?.();
      if (realpathSync(root) !== physicalRoot || readCwd(context, args) !== cwd) throw new ToolInputProjectionError('held');
    } };
    const timeoutMs = clampTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_BACKGROUND_TIMEOUT_MS);
    const { processClass, killOnTimeout, result } = await spawnClassifiedBackgroundProcess(manager, args, command, cwd, timeoutMs, launchOptions);
    return {
      status: 'started',
      processClass,
      killOnTimeout,
      timeoutBehavior: timeoutMs === 0 ? 'No automatic deadline; stop it explicitly with process action:"kill".' : killOnTimeout
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
      policy: 'Started as a tracked local background process with visible monitor/live-tail routes.',
    };
  }

  if (action === 'stop' || action === 'kill' || action === 'cancel') {
    assertEffect();
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process stop requires processId.');
    const getStatus = manager.getStatus, entry = getStatus.call(manager, processId), stop = manager.stop;
    assertEffect();
    if (manager.stop !== stop || manager.getStatus !== getStatus || getStatus.call(manager, processId) !== entry) throw new ToolInputProjectionError('held');
    const stopped = stop.call(manager, processId);
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
    const current = processClassificationOptions(context), supplied = options;
    const waiting = { ...supplied, assertCurrent: () => { current.assertCurrent?.(); supplied.assertCurrent?.(); } };
    const processId = readProcessId(args);
    if (!processId) throw new Error('Background process wait requires processId.');
    const timeoutMs = clampTimeout(args.timeoutMs ?? readField(args, 'timeoutMs'), DEFAULT_WAIT_TIMEOUT_MS);
    const entry = await waitForProcess(manager, processId, timeoutMs, waiting);
    waiting.assertCurrent();
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

  if (action === 'list') return backgroundProcessSummary(context, args, options);
  if (action === 'status' || action === 'log' || action === 'output') {
    const resolved = await describeBackgroundProcess(context, args, options);
    if (resolved.status === 'found') return resolved.process;
    return {
      status: resolved.status,
      ...(resolved.status === 'ambiguous' ? { input: resolved.input, candidates: resolved.candidates } : { usage: resolved.usage }),
    };
  }

  throw new Error('run_background_process requires processAction start, stop/kill, wait, list, status/poll, log/output, write, or capabilities.');
}
