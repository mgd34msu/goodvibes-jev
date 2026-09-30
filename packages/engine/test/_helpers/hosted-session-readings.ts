/**
 * Deterministic judgment fixtures for real hosted-session compositions. Install
 * AFTER createClientRuntimeServices (which installs its live settings port),
 * and restore BEFORE disposing that floor. The provider stub alone cannot
 * answer the separate intake, permission and exec decisions. Other decisions
 * fail loudly rather than silently receiving an unrelated fixture answer.
 */
import type { JudgmentPort, JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetCredentialEnvReadings } from '../../sdk/src/platform/tools/exec/credential-env.ts';
import { forgetGateReadings, type GateReadingTable } from './gate-readings.ts';
import { toolReadingsPort, type ToolReadingTable } from './tool-readings.ts';

export function installHostedSessionReadings(options: {
  readonly tools?: ToolReadingTable;
  readonly gate?: GateReadingTable;
} = {}) {
  const intake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'converse', 0.97);
    throw new Error(`hosted session intake fixture: unexpected question ${name}`);
  });
  const tools = toolReadingsPort(options.tools, options.gate);
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = {
    model: intake.port.model,
    async ask(request) {
      requests.push(request as JudgmentRequest<Questions>);
      const battery = request.context?.battery;
      if (battery === 'contract.request-route') return intake.port.ask(request);
      if (battery?.startsWith('engine.gate.') || battery?.startsWith('engine.tools.')) return tools.port.ask(request);
      throw new Error(`hosted session fixture: unexpected decision ${battery ?? '(unnamed)'}`);
    },
  };
  forgetGateReadings();
  forgetCredentialEnvReadings();
  const previous = installJudgmentPort(port);
  return {
    requests,
    restore(): void {
      installJudgmentPort(previous);
      forgetGateReadings();
      forgetCredentialEnvReadings();
    },
  };
}
