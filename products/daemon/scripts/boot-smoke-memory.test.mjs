import { expect, test } from 'bun:test';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { useGatewayFixture } from '../src/test/helpers/gateway-fixture.ts';
import { createProductionDaemonInboxFactory } from '../src/runtime/production-inbox-composition.ts';
import { proveNativeMemoryRoundTrip } from './boot-smoke-reading.mjs';
const fixture = useGatewayFixture({ hostSessions: false, inboxFactory: createProductionDaemonInboxFactory() });

test('compiled memory assertion body executes actual product HTTP owners and native vector queries in source qualification', async () => {
  const fx = fixture();
  const readings = fakePort((_name, question) => {
    if (question.type === 'noul') return noulAnswer(0.99);
    throw new Error('Unexpected synthetic memory question');
  });
  const previous = installJudgmentPort(withDecisionLog(readings.port, fx.services.judgment.decisionLog));
  try {
    const result = await proveNativeMemoryRoundTrip(async (method, body = {}) => {
      const response = await fx.fetch(`/api/control-plane/methods/${method}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      const text = await response.text(); expect(response.status, text).toBe(method === 'memory.records.add' ? 201 : 200); return JSON.parse(text);
    });
    expect(result.vector.vector.available).toBe(true);
    expect(readings.requests.length).toBeGreaterThan(0);
  } finally { installJudgmentPort(previous); }
});
