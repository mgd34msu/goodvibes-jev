/** Real daemon child registry producer, public core admission, synthetic readings only. */
import { expect, spyOn, test } from 'bun:test';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { executeToolCalls } from '@goodvibes-jev/engine/sdk/platform/core';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';
const fixture = useGatewayFixture({ hostSessions: false });

test('daemon root child registry receives canonical exact-plan sandbox admission', async () => {
  const daemon = fixture(); const services = daemon.services;
  let sandboxAdmissions = 0;
  const answers = fakePort((name, question, state) => {
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.98);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.98);
    if (name === 'kind') return choiceAnswer(question, 'other', 0.98);
    if (name === 'category') return choiceAnswer(question, 'lasting', 0.98);
    if (name === 'hazard') return choiceAnswer(question, 'none', 0.98);
    if (name === 'needsNetwork') return noulAnswer(JSON.stringify(state).includes('owned-daemon-sandbox') ? 0.98 : 0.02);
    if (name === 'mutates' || name === 'owned_targets') return noulAnswer(0.98);
    if (name === 'credential') return noulAnswer(/key|token|secret|password|credential/i.test(String((state as { name?: string }).name)) ? 0.98 : 0.02);
    if (question.type === 'noul') return noulAnswer(0.02);
    throw new Error(`Unscripted daemon sandbox question: ${name}`);
  });
  const recorded = withDecisionLog(answers.port, services.judgment.decisionLog);
  const port = spyOn(services.judgment.port, 'ask').mockImplementation(request => {
    if ('disposition' in request.questions && JSON.stringify(request.state).includes('sandboxEscalation')) sandboxAdmissions++;
    return recorded.ask(request);
  });
  const human = spyOn(services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('Human fallback forbidden'); });
  try {
    const registry = services.agentOrchestrator.getToolRegistry();
    await executeToolCalls({ autonomousSource: () => ({ goal: 'Run only the owned daemon sandbox fixture', criteria: ['Keep the exact existing containment plan', 'No external operation or human wait'] }),
      permissionManager: services.permissionManager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
      sessionId: 'daemon-sandbox-fixture', emitterContext: () => ({ sessionId: 'daemon-sandbox-fixture', traceId: 'fixture', source: 'orchestrator' }),
    }, 'daemon-sandbox', [{ id: 'daemon-sandbox-call', name: 'exec', arguments: { commands: [{ cmd: 'printf owned-daemon-sandbox', timeout_ms: 1000 }] } }]);
    expect(sandboxAdmissions).toBe(1); expect(human).not.toHaveBeenCalled();
    // Admission plumbing is proved even on a host where native isolation refuses.
    // No successful command or live semantic calibration is asserted here.
  } finally { port.mockRestore(); human.mockRestore(); }
});
