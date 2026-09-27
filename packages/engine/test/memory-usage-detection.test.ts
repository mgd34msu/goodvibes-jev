import { describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { detectReferencedMemoryIds } from '../sdk/src/platform/state/index.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

/**
 * Two-tier reference detection: each injected memory is read by the
 * `engine.state.memory-usage` battery against the response. 'referenced' only
 * when the reading says yes; an uncertain or no reading is 'present'.
 */
describe('detectReferencedMemoryIds', () => {
  const readings = useMemoryReadings();

  test('asks one usage question per memory, carrying the memory text and the response', async () => {
    readings.use({ usage: (memory) => (memory.summary.includes('rollout') ? 0.95 : 0.05) });
    const result = await detectReferencedMemoryIds('I ran deploy/rollout.sh as configured.', [
      { id: 'm1', summary: 'Kubernetes rollout script', detail: 'deploy/rollout.sh' },
      { id: 'm2', summary: 'Release checklist' },
    ]);
    expect(result.referenced).toEqual(['m1']);
    expect(result.present).toEqual(['m2']);
    expect(result.perId.get('m1')).toBe('referenced');
    expect(result.perId.get('m2')).toBe('present');
    expect(readings.requests).toHaveLength(2);
    expect(readings.requests[0]!.state).toEqual({
      memory: { summary: 'Kubernetes rollout script', detail: 'deploy/rollout.sh' },
      response: 'I ran deploy/rollout.sh as configured.',
    });
  });

  test('an uncertain reading stays present: the tier claims use only on a yes', async () => {
    readings.use({ usage: () => 0.5 });
    const result = await detectReferencedMemoryIds('maybe related text', [{ id: 'u', summary: 'something' }]);
    expect(result.perId.get('u')).toBe('present');
    expect(result.referenced).toEqual([]);
  });

  test('no records means no requests', async () => {
    const result = await detectReferencedMemoryIds('anything', []);
    expect(result.referenced).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });

  test('a read with no judgment port installed throws', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      await expect(detectReferencedMemoryIds('text', [{ id: 'x', summary: 'y' }])).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
