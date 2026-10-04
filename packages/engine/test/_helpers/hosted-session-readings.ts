/**
 * Deterministic judgment fixtures for real hosted-session compositions. Install
 * AFTER createClientRuntimeServices (which installs its live settings port),
 * and restore BEFORE disposing that floor. The provider stub alone cannot
 * answer the separate intake, permission and exec decisions. The real decision
 * recorder remains installed: autonomous preparation and admission must own
 * recorded evidence here just as they do on the live hosted floor. Other decisions
 * fail loudly rather than silently receiving an unrelated fixture answer.
 */
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetCredentialEnvReadings } from '../../sdk/src/platform/tools/exec/credential-env.ts';
import { forgetGateReadings, type GateReadingTable } from './gate-readings.ts';
import { coreReadingsPort } from './core-readings.ts';
import { toolReadingsPort, type ToolReadingTable } from './tool-readings.ts';

export function installHostedSessionReadings(options: {
  readonly tools?: ToolReadingTable;
  readonly gate?: GateReadingTable;
  readonly disposition?: 'act' | 'reject' | 'defer_0';
} = {}) {
  const intake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'converse', 0.97);
    throw new Error(`hosted session intake fixture: unexpected question ${name}`);
  });
  const admission = fakePort((name, question) => {
    if (name === 'disposition') return choiceAnswer(question, options.disposition ?? 'act', 0.97);
    throw new Error(`hosted session admission fixture: unexpected question ${name}`);
  });
  const log = new SqliteDecisionLog(':memory:');
  const core = coreReadingsPort({ intent: 'chat', needsPlan: false, strategy: 'single' });
  const tools = toolReadingsPort(options.tools, options.gate);
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = {
    model: intake.port.model,
    async ask(request) {
      request.signal?.throwIfAborted();
      request.beforeAttempt?.();
      requests.push(request as JudgmentRequest<Questions>);
      if (request.context?.site === 'engine.gate.autonomous-tool') return admission.port.ask(request);
      const battery = request.context?.battery;
      if (battery === 'engine.core.turn-shape' || battery === 'engine.core.execution-strategy') return core.port.ask(request);
      if (battery === 'contract.request-route') return intake.port.ask(request);
      if (battery?.startsWith('engine.gate.') || battery?.startsWith('engine.tools.')) return tools.port.ask(request);
      throw new Error(`hosted session fixture: unexpected decision ${battery ?? '(unnamed)'}`);
    },
  };
  forgetGateReadings();
  forgetCredentialEnvReadings();
  const previous = installJudgmentPort(withDecisionLog(port, log));
  return {
    requests,
    log,
    restore(): void {
      installJudgmentPort(previous);
      log[Symbol.dispose]();
      forgetGateReadings();
      forgetCredentialEnvReadings();
    },
  };
}
