import type { BootstrapContext } from '../runtime/bootstrap.ts';
import { dispatchNativeConversationTurn } from '../runtime/native-conversation-ingress.ts';
import type { NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeHeadlessTurnResult } from './native-headless.ts';
import type { TurnEvent } from '@/runtime/index.ts';

/** Ordinary prompts go directly to the model; explicit native recovery retains its permit. */
export async function executeHeadlessTurn(ctx: BootstrapContext, input: string | NativeConversationIntakeState, signal: AbortSignal, format: string): Promise<NativeHeadlessTurnResult> {
  const runner = ctx.uiServices.agents.contractRunner;
  const agents = ctx.uiServices.agents.agentManager;
  const existingAgents = new Set(agents.list().map(agent => agent.id));
  const ownedAgents = () => agents.list().filter(agent => !existingAgents.has(agent.id));
  const existing = new Set(runner.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true }).map(contract => contract.id));
  const owned = () => runner.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true }).filter(contract => !existing.has(contract.id));
  let response = ''; let error = ''; let stopReason = 'turn-unsettled'; let exitCode = 3; let events = 0;
  const unsubs = [
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
      events++;
      if (format === 'stream-json') process.stdout.write(JSON.stringify({ type: payload.type, content: payload.content, accumulated: payload.accumulated }) + '\n');
    }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => { events++; response = payload.response; stopReason = payload.stopReason; exitCode = 0; }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => { events++; error = payload.error; stopReason = payload.stopReason; exitCode = 1; }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => { events++; error = payload.reason ?? 'cancelled'; stopReason = payload.stopReason; exitCode = 130; }),
  ];
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => {
    ctx.orchestrator.abort();
    for (const contract of owned()) runner.cancel(contract.id, 'Headless invocation cancelled');
    for (const agent of ownedAgents()) agents.cancel(agent.id);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
    if (typeof input === 'string') await ctx.orchestrator.handleUserInput(input);
    else await dispatchNativeConversationTurn(input, ctx.orchestrator);
    // Delegation completes the foreground model turn before the contract's work.
    // Keep this invocation alive and return the actual deliverable before shutdown.
    const collected = new Set<string>();
    const answers: string[] = [];
    const collectedAgents = new Set<string>();
    for (;;) {
      const contracts = owned().filter(contract => !collected.has(contract.id));
      const standalone = ownedAgents().filter(agent => !agent.contractId && !collectedAgents.has(agent.id));
      if (!contracts.length && !standalone.length) break;
      for (const contract of contracts) {
        collected.add(contract.id);
        await new Promise<void>(resolve => {
          const done = () => {
            const current = runner.get(contract.id);
            return signal.aborted || !current || ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(current.status);
          };
          const finish = () => { unsubscribe(); signal.removeEventListener('abort', finish); resolve(); };
          const unsubscribe = runner.on(() => { if (done()) finish(); });
          signal.addEventListener('abort', finish, { once: true });
          if (done()) finish();
        });
        const current = runner.get(contract.id);
        if (current?.status === 'passed') {
          await runner.join(contract.id);
          if (current.answer) answers.push(current.answer);
        } else {
          exitCode = signal.aborted || current?.status === 'cancelled' ? 130 : 1;
          stopReason = current?.status === 'awaiting-owner' ? 'awaiting-owner' : 'contract-failed';
          error = current?.error ?? current?.statusLine ?? 'Delegated work did not complete.';
        }
      }
      for (const agent of standalone) {
        collectedAgents.add(agent.id);
        await agents.join(agent.id);
        const current = agents.getStatus(agent.id);
        if (current?.status === 'completed' && current.fullOutput?.trim()) answers.push(current.fullOutput);
        else {
          exitCode = signal.aborted || current?.status === 'cancelled' ? 130 : 1;
          stopReason = 'agent-failed';
          error = current?.error ?? `Delegated agent ${agent.id} did not return a completed report.`;
        }
      }
    }
    if (answers.length) { response = answers.join('\n\n'); if (exitCode === 0) stopReason = 'completed'; }
    if (signal.aborted) exitCode = 130;
    if (exitCode === 0 && !response.trim()) {
      exitCode = 1; stopReason = 'empty_response'; error ||= 'The model returned no response.';
    }
    return { exitCode, response, error, stopReason, sessionId: ctx.runtime.sessionId, model: ctx.runtime.model, provider: ctx.runtime.provider, events };
  } finally { signal.removeEventListener('abort', abort); for (const unsubscribe of unsubs) unsubscribe(); }
}
