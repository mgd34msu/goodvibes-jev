import { expect, type Page } from '@playwright/test';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';

/** Explicit synthetic readings, never a lexical scorer or live provider. */
export async function installPaletteReading(page: Page, commandId: string, outcome: 'act' | 'confirm' | 'escalate' = 'act', beforeReply?: () => Promise<void>): Promise<void> {
  await page.route('**/api/judgment/batteries/run', async (route) => {
    const request = route.request().postDataJSON() as BrowserJudgmentRequest<'webui.palette.command-rank'>;
    expect(request.battery).toBe('webui.palette.command-rank');
    const selected = request.input.candidates.findIndex((candidate) => candidate.kind === 'builtin' && candidate.commandId === commandId);
    expect(selected).toBeGreaterThanOrEqual(0);
    const count = request.input.candidates.length;
    await beforeReply?.();
    await route.fulfill({ json: { protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1,
      ...(outcome === 'act' ? { status: 'settled', value: { registryVersion: request.input.registryVersion,
        accepted: [{ candidateIndex: selected, probability: 0.93 }], rejected: Array.from({ length: count }, (_, i) => i).filter((i) => i !== selected) } }
        : { status: 'held', reason: 'uncertain' }), outcome,
      readings: Object.fromEntries(Array.from({ length: count }, (_, i) => [`candidate_${i}`, { kind: 'yes-no',
        probability: i === selected ? 0.93 : 0.03, verdict: i === selected ? 'yes' : 'no', outcome: i === selected ? outcome : 'act' }])),
      evidence: Array.from({ length: count }, (_, i) => ({ decisionId: `offline-fixture-${i}`, model: 'fixture-v1', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 })),
    } });
  });
}
