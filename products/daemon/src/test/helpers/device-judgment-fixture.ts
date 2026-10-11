/** Genuine recorded synthetic transport. The host source is fixed separately from request prose. */
import { afterAll, beforeAll } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { makeOwnedTempDir } from './owned-temp.js';
import { gateReadingsPort } from './synthetic-gate-readings.js';
export interface DeviceReading {
  request: { nodeId: string; nodeLabel: string; capabilityId: string; reason: string; allowAlwaysOffered: boolean; input: Record<string, unknown> };
  policy: { requestTimeoutMs: number };
  purpose: string;
  grant: unknown;
}
const logs: SqliteDecisionLog[] = [];
const nativeGate = gateReadingsPort();
const nativeChoice = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.99) : choiceAnswer(question, 'act', 0.99));
let nativePort: ReturnType<typeof withDecisionLog>;
let previous: ReturnType<typeof installJudgmentPort>;
export function useDeviceJudgmentRuntime(): void {
beforeAll(() => {
  const log = new SqliteDecisionLog(':memory:'); logs.push(log);
  nativePort = withDecisionLog({ model: 'synthetic/native-device-caller', ask(request) {
    return 'disposition' in request.questions || 'refuse' in request.questions ? nativeChoice.port.ask(request) : nativeGate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(nativePort);
});
afterAll(() => { installJudgmentPort(previous); for (const log of logs.splice(0)) log[Symbol.dispose](); });
}
export function deviceJudgmentFixture() {
  const log = new SqliteDecisionLog(':memory:'); logs.push(log);
  const directory = makeOwnedTempDir('device-native-caller');
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'tui' });
  const manager = new PermissionManager(async () => { throw new Error('No human caller fallback'); },
    createPermissionConfigReader(config), new PolicyRuntimeState());
  let answer = 'once'; let source = { goal: 'Use the synthetic paired phone for the explicitly requested capability.', criteria: ['Only the current synthetic peer and exact requested operation.'] };
  const lifetime = new AbortController(); const readings: DeviceReading[] = [];
  let hook: ((reading: DeviceReading) => void | Promise<void>) | undefined;
  const fake = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.99)
    : choiceAnswer(question, answer === 'deny' ? 'reject' : answer === 'always' && question.type === 'choice' && 'revise_0' in question.criteria ? 'revise_0' : 'act', 0.99));
  const port = withDecisionLog({ model: fake.port.model, async ask(request) {
    request.beforeAttempt?.();
    const reading = (request.state as { input: EntryType }).input as unknown as DeviceReading;
    readings.push(reading); await hook?.(reading); request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return fake.port.ask(request);
  } }, log);
  return { port, log, readings, lifetime, requests: fake.requests,
    get grantEvaluations() { return readings.filter(reading => reading.purpose === 'dispatch' && reading.grant === null); },
    answer(next: string) { answer = next; }, onReading(next: typeof hook) { hook = next; },
    changeSource(goal: string) { source = { ...source, goal }; },
    async run<T>(body: () => T): Promise<Awaited<T>> {
      // The source is carried by the real public native tool executor after a
      // genuine recorded admission. Tests cannot set the private ambient scope.
      const registry = new ToolRegistry(manager);
      let outcome: { value: Awaited<T> } | { error: unknown } | undefined;
      registry.register({ definition: { name: 'device-proof-operation', description: 'Invoke the owned synthetic device fixture operation',
        parameters: { type: 'object', properties: {}, additionalProperties: false } },
        async execute() {
          try { outcome = { value: await body() }; return { success: true, output: 'Operation completed' }; }
          catch (error) { outcome = { error }; return { success: false, error: 'Synthetic operation raised' }; }
        },
      });
      const deps: ToolExecutionDeps = { autonomousSource: () => source, autonomousPort: () => nativePort,
        turnSignal: lifetime.signal, permissionManager: manager, toolRegistry: registry,
        hookDispatcher: null, runtimeBus: null, sessionId: 'device-native-fixture',
        emitterContext: () => ({ sessionId: 'device-native-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
      const result = await executeToolCalls(deps, crypto.randomUUID(), [{ id: crypto.randomUUID(), name: 'device-proof-operation', arguments: {} }]);
      if (!outcome) throw new Error(`Native fixture operation was not entered: ${result[0]?.error ?? 'unknown refusal'}`);
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },
  };
}
