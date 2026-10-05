import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { FOLLOWUP_CAPTURES } from './session-followup-fixture';

describe('real follow-up HTTP capture provenance', () => {
  test('bare capacity 429 does not prove that the input was rejected', () => {
    const capture = JSON.parse(readFileSync(new URL('./fixtures/session-followup/capacity.json', import.meta.url), 'utf8'));
    const post = JSON.parse(capture.post.body);
    const queued = JSON.parse(capture.queued.body);
    const schema = operatorContract.operator.methods.find(entry => entry.id === 'sessions.inputs.list')?.outputSchema;
    expect(capture.post.status).toBe(429);
    expect(post.code).toBe('CAPACITY_EXCEEDED');
    expect(post.input).toBeUndefined();
    expect(firstJsonSchemaFailure(schema!, queued)).toBeUndefined();
    expect(queued.inputs).toHaveLength(1);
    expect(queued.inputs[0]).toMatchObject({ sessionId: 's-capacity', intent: 'follow-up', state: 'queued' });
    const second = JSON.parse(capture.second.body);
    const afterSpawn = JSON.parse(capture.afterSpawn.body) as { inputs: { id: string; state: string }[] };
    expect(capture.second.status).toBe(202);
    expect(second.input.state).toBe('spawned');
    expect(firstJsonSchemaFailure(schema!, afterSpawn)).toBeUndefined();
    expect(afterSpawn.inputs.find(input => input.id === second.input.id)?.state).toBe('queued');
    expect(afterSpawn.inputs.find(input => input.id === queued.inputs[0].id)?.state).toBe('spawned');
  });
  for (const capture of Object.values(FOLLOWUP_CAPTURES)) {
    test(`registered TUI follow-up: queued-for-surface through ${capture.outcome}`, () => {
      const registered = JSON.parse(capture.registration.body);
      const post = JSON.parse(capture.post.body);
      const queued = JSON.parse(capture.queued.body);
      expect(capture.source).toBe('packages/engine/test/session-followup-receipts-http.test.ts');
      expect(registered.session.kind).toBe('tui');
      expect(registered.session.metadata.surfaceManaged).toBe(true);
      expect(registered.session.participants).toMatchObject([{ surfaceKind: 'tui', surfaceId: 'surface:tui:receipt-proof' }]);
      expect(registered.session.activeAgentId).toBeUndefined();
      expect(capture.post.status).toBe(202);
      expect(post.mode).toBe('queued-for-surface');
      expect(post.agentId).toBeNull();
      expect(post.input).toEqual(queued.inputs[0]);
      expect(capture.terminalInput.id).toBe(capture.input.id);
      expect(capture.terminalInput.state).toBe(capture.outcome);
      expect(capture.terminalInput.updatedAt).toBeGreaterThanOrEqual(capture.input.updatedAt);
      if (capture.delivered) {
        expect(JSON.parse(capture.delivery!.body).input.state).toBe('delivered');
        expect(JSON.parse(capture.delivered.body).inputs[0]).toMatchObject({ id: capture.input.id, state: 'delivered' });
      }
      if (capture.outcome === 'failed') {
        expect(capture.terminalMutation?.method).toBe('SharedSessionBroker.failInput');
        expect(capture.terminalInput.error).toBe(capture.terminalMutation?.error);
      } else {
        expect(capture.terminalWrite?.status).toBe(200);
        expect(JSON.parse(capture.terminalWrite!.body).input.state).toBe(capture.outcome);
      }
    });
  }
});
