import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import type { OperatorContractMethodEntry } from '../agent/operator-contract-routes.ts';
import { getOperatorActions, isOperatorActionId, targetValue } from '../agent/operator-actions.ts';
import { captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { captureOperatorAutomationTarget, type OperatorAutomationTarget } from '../agent/operator-automation-target.ts';
import { captureOperatorRequestPolicy } from '../agent/operator-request-policy.ts';

// These exact contract methods dispatch messages, remote commands or metered work.
const OUTWARD_METHOD_IDS = new Set([
  'email.send', 'channels.actions.invoke', 'channels.tools.invoke', 'channels.accounts.action.default',
  'channels.accounts.action.named', 'remote.peers.invoke', 'web_search.query', 'judgment.battery.run',
  'voice.realtime.session', 'voice.stt', 'voice.tts', 'voice.tts.stream', 'sessions.messages.create',
  'sessions.inputs.deliver', 'sessions.followUp', 'sessions.steer', 'companion.chat.messages.create',
  'companion.chat.messages.edit', 'companion.chat.messages.retry', 'companion.chat.messages.steer',
  'contracts.start', 'contracts.reply', 'workLedger.turn.start', 'workLedger.turn.startAgent',
  'workLedger.execution.start', 'workLedger.execution.resume', 'automation.jobs.run',
  'automation.schedules.run', 'automation.runs.retry', 'checkin.run',
  'media.analyze', 'media.transform', 'media.generate', 'memory.vector.rebuild',
  'tasks.create', 'tasks.retry',
]);

export function operatorMethodIsOutward(methodId: string): boolean { return OUTWARD_METHOD_IDS.has(methodId); }

type CapturedConnection = ReturnType<typeof captureOperatorConnection>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const contexts = new WeakMap<object, { readonly connection: CapturedConnection | undefined; readonly assertCurrent: () => void;
  readonly automation: OperatorAutomationTarget; readonly requestPolicy: ReturnType<typeof captureOperatorRequestPolicy> | undefined;
  readonly shellPaths: ShellPathService; readonly reader: AgentConnectedHostConfigReader; readonly kind: 'method' | 'action' }>();

export function findConnectedOperatorMethod(methodId: string): OperatorContractMethodEntry | null {
  const methods = getOperatorContract().operator.methods;
  const named = methods.map(method => ({ method, descriptor: Object.getOwnPropertyDescriptor(method, 'id') }));
  return named.find(entry => entry.descriptor && 'value' in entry.descriptor && entry.descriptor.value === methodId)?.method
    ?? named.find(entry => entry.descriptor && 'value' in entry.descriptor && typeof entry.descriptor.value === 'string'
      && entry.descriptor.value.toLowerCase() === methodId.toLowerCase())?.method ?? null;
}

/** Scopes are the contract's closed authorization grammar, never prose inference. */
export function operatorMethodIsReadOnly(method: OperatorContractMethodEntry, input?: unknown): boolean {
  // The native screenshot route trims an optional caller-selected destination.
  // Its default owned observation artifact remains an ordinary read.
  if (method.id === 'browser.screenshot' && isRecord(input) && typeof input.path === 'string' && input.path.trim()) return false;
  const scopes = method.scopes ?? [], httpMethod = method.http?.method?.toUpperCase();
  return scopes.length > 0 ? scopes.every(scope => scope.startsWith('read:'))
    : httpMethod === 'GET' || httpMethod === 'HEAD' || httpMethod === 'OPTIONS';
}

/** Capture connection authority before any repair or admission reading. */
export function createOperatorInputProjector(shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader,
  kind: 'method' | 'action'): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const args = captureStrictJudgmentJson(request.args);
    const id = kind === 'method' ? args.methodId : args.action;
    if (typeof id !== 'string' || !id.trim()) throw new ToolInputProjectionError('held');
    const method = findConnectedOperatorMethod(id.trim());
    if (!method) throw new ToolInputProjectionError('held');
    const snapshot = captureStrictJudgmentJson(method);
    const descriptor = kind === 'action' && isOperatorActionId(id) ? getOperatorActions()[id] : undefined;
    if (kind === 'action' && !descriptor) throw new ToolInputProjectionError('held');
    const descriptorSnapshot = captureStrictJudgmentJson(descriptor);
    const preview = kind === 'method' && args.dryRun === true;
    const requestPolicy = !preview && (kind === 'action' || !operatorMethodIsReadOnly(snapshot, args.input) || operatorMethodIsOutward(snapshot.id))
      ? captureOperatorRequestPolicy() : undefined;
    const assertSource = () => {
      request.signal?.throwIfAborted();
      requestPolicy?.assertCurrent();
      if (findConnectedOperatorMethod(id.trim()) !== method || !isDeepStrictEqual(captureStrictJudgmentJson(method), snapshot)
        || (descriptor && (!isOperatorActionId(id) || getOperatorActions()[id] !== descriptor
          || !isDeepStrictEqual(captureStrictJudgmentJson(descriptor), descriptorSnapshot)))) throw new ToolInputProjectionError('stale');
    };
    const connection = preview ? undefined : captureOperatorConnection(shellPaths, reader, assertSource);
    let automation: OperatorAutomationTarget = { wireFields: {} };
    if (connection) {
      const input = kind === 'method' ? args.input : args;
      const parameters = isRecord(input) ? captureStrictJudgmentJson(input) : {};
      const targetInput = descriptor ? { ...parameters, [descriptor.targetField]: targetValue(parameters, descriptor) } : parameters;
      automation = await captureOperatorAutomationTarget(snapshot.id, targetInput, connection,
        { signal: request.signal, assertCurrent: () => { request.assertCurrent(); assertSource(); } });
    }
    const context = Object.freeze({}); let released = false;
    const assertCurrent = () => {
      if (released) throw new ToolInputProjectionError('released');
      assertSource(); connection?.assertCurrent();
    };
    const assertPrepared = () => { request.assertCurrent(); assertCurrent(); request.assertCurrent(); };
    contexts.set(context, { connection, assertCurrent, automation, requestPolicy, shellPaths, reader, kind }); assertPrepared();
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent: assertPrepared,
      ...(preview || (operatorMethodIsReadOnly(snapshot, args.input) && !operatorMethodIsOutward(snapshot.id)) ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(repaired) {
        if (!isDeepStrictEqual(captureStrictJudgmentJson(repaired), args)) throw new ToolInputProjectionError('binding-changed');
        assertPrepared();
      },
      async release() { released = true; contexts.delete(context); },
    };
  } };
}

/** An actual registered execution alone can retrieve its pre-admission connection. */
export function operatorExecutionConnection(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action'): CapturedConnection | undefined {
  const context = options?.inputProjectionContext;
  if (!context) return undefined;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return binding.connection;
}

/** Apply only private native fields retained by this exact registered owner. */
export function operatorExecutionWireInput(input: Record<string, unknown>, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action'): Record<string, unknown> {
  const context = options?.inputProjectionContext;
  if (!context) return input;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return { ...input, ...binding.automation.wireFields };
}

export function operatorExecutionRequestPolicy(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action') {
  const context = options?.inputProjectionContext;
  if (!context) return undefined;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return binding.requestPolicy;
}
