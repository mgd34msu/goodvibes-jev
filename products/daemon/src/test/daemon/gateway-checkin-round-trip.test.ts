/**
 * The proactive check-in loop, end to end, over this daemon's own composition.
 *
 * Ported from goodvibes-agent/src/test/daemon/checkin-gateway.test.ts. That
 * package composes no server and serves no gateway verb; the suite drove a
 * catalog a test helper rebuilt from a hand-copied dependency list. The
 * behaviour it pinned is real and still worth pinning, at the process that
 * implements it. Here the catalog is `createRuntimeServices(...).gatewayMethods`.
 *
 * The SDK registers checkin.* handlers only when channelDeliveryRouter,
 * providerRegistry, automationManager and sessionLister are ALL present (see
 * register-gateway-verb-groups.ts). This composition threads all four, so the
 * verbs answer for real rather than 501 "Gateway method is not invokable".
 *
 * These drive the loop exactly as the operator HTTP surface invokes it:
 * briefing -> judgment -> conditional delivery -> receipt. Every run leaves a
 * visible, accountable record, including the runs that deliver nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { useGatewayFixture } from '../helpers/gateway-route-fixture.js';
const fixture = useGatewayFixture({ hostSessions: false });
const readings = fakePort(() => noulAnswer(0.01));
let log: SqliteDecisionLog;
let previous: JudgmentPort | undefined;
beforeAll(() => { log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(readings.port, log)); });
afterAll(() => { installJudgmentPort(previous); log?.[Symbol.dispose](); });



interface CheckinReceipt {
  readonly id: string;
  readonly ranAt: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly outcome: 'delivered' | 'quiet' | 'skipped-disabled' | 'skipped-quiet-hours' | 'error';
  readonly briefingSummary: string;
  readonly deliveredMessage?: string;
  readonly deliveryId?: string;
  readonly judgment?: { readonly decisionId: string; readonly reading: { readonly verdict: string } };
}

async function invoke<T>(methodId: string, body: Record<string, unknown> = {}): Promise<T> {
  const services = () => fixture().services;
  // Pin the current chat route to the instant mock model the test helper seeds.
  // The check-in judge makes one provider.chat call against the registry's
  // CURRENT model; left at the default route it can stall toward the judge's own
  // 20s timeout (no credentials, real provider) and blow bun's per-test budget
  // under full-suite load. setCurrentModel, not a config write: the registry
  // reads its configured model key once at construction, so a config write after
  // construction does not retarget it.
  services().providerRegistry.setCurrentModel('mock:mock-model');
  return services().gatewayMethods.invoke(methodId, { methodId, body } as never) as Promise<T>;
}

/**
 * A five-minute window centred on the current instant, in local 'HH:MM-HH:MM'.
 * Always covers "now" whenever the suite runs, including across midnight.
 */
function quietHoursCoveringNow(): string {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const fmt = (minutes: number): string => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const mm = String(wrapped % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };
  return `${fmt(nowMinutes - 2)}-${fmt(nowMinutes + 2)}`;
}

describe('checkin gateway verb group (live on the composed daemon, not a 501 facade)', () => {
  test('descriptors are registered on the composed catalog with handlers attached', () => {
    const services = () => fixture().services;
    for (const methodId of ['checkin.config.get', 'checkin.config.set', 'checkin.run', 'checkin.receipts.list']) {
      expect(services().gatewayMethods.get(methodId), `${methodId} descriptor missing from the catalog`).toBeTruthy();
      expect(services().gatewayMethods.hasHandler(methodId), `${methodId} has no handler`).toBe(true);
    }
  });

  test('checkin.enabled defaults to false', async () => {
    const { config } = await invoke<{ config: { enabled: boolean } }>('checkin.config.get');
    expect(config.enabled).toBe(false);
  });

  test('an enabled check-in run produces a receipt', async () => {
    await invoke('checkin.config.set', { enabled: true, quietHours: '' });

    const runResult = await invoke<{ outcome: string; summary: string }>('checkin.run');
    expect(runResult.outcome).toBe('quiet');
    expect(readings.requests).toHaveLength(1);
    expect(typeof runResult.summary).toBe('string');

    const { receipts } = await invoke<{ receipts: CheckinReceipt[] }>('checkin.receipts.list');
    expect(receipts.length).toBeGreaterThan(0);
    const latest = receipts[0]!;
    expect(latest.trigger).toBe('manual');
    expect(latest.judgment?.decisionId).toBeTruthy();
    expect(latest.judgment?.reading.verdict).toBe('no');
    expect(latest.deliveryId).toBeUndefined();
    expect(typeof latest.briefingSummary).toBe('string');
  });

  test('quiet hours suppress delivery but still record a receipt (ran-quiet)', async () => {
    await invoke('checkin.config.set', { enabled: true, quietHours: quietHoursCoveringNow() });

    const runResult = await invoke<{ outcome: string }>('checkin.run');
    // checkin.run collapses the receipt's granular outcome to 'skipped' on the wire.
    expect(runResult.outcome).toBe('skipped');

    const { receipts } = await invoke<{ receipts: CheckinReceipt[] }>('checkin.receipts.list');
    const latest = receipts[0]!;
    expect(latest.outcome).toBe('skipped-quiet-hours');
    expect(latest.deliveredMessage).toBeUndefined();
    expect(latest.deliveryId).toBeUndefined();
  });

  test('a disabled check-in run is recorded but never delivers', async () => {
    await invoke('checkin.config.set', { enabled: false, quietHours: '' });

    const runResult = await invoke<{ outcome: string }>('checkin.run');
    expect(runResult.outcome).toBe('skipped');

    const { receipts } = await invoke<{ receipts: CheckinReceipt[] }>('checkin.receipts.list');
    const latest = receipts[0]!;
    expect(latest.outcome).toBe('skipped-disabled');
    expect(latest.deliveryId).toBeUndefined();
  });
});
