import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { PostalAddressHeldError, readConfigSettingForDisplay } from '../sdk/src/platform/config/postal-address.ts';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { createProfilePostalReader } from '../sdk/src/platform/owner-profile/postal-reading.ts';
import type { PostalProviders } from '../sdk/src/platform/owner-profile/postal-proposer.ts';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const parts = { name: null, line1: '10 Downing St', line2: null, city: 'London', region: null, postalCode: 'SW1A 2AA', country: 'UK' };
function fixture(source = '10 Downing St, London SW1A 2AA, UK') {
  const root = mkdtempSync(join(tmpdir(), 'postal-reading-')); roots.push(root);
  const path = join(root, 'profile.md'); writeFileSync(path, `# Owner\n\n## Commerce\nshipping address: ${source}\n`);
  const store = new OwnerProfileStore({ path }); store.loadSync();
  mkdirSync(join(root, 'cfg'));
  const config = new ConfigManager({ surfaceRoot: 'daemon', homeDir: root, configDir: join(root, 'cfg') });
  let calls = 0, revision = 0, wrong = false;
  const provider = { async chat() { calls += 1; return { content: JSON.stringify(parts), toolCalls: [], stopReason: 'completed' }; } };
  const providers = { getCurrentModel: () => ({ id: 'fixture', registryKey: 'fixture:fixture', provider: 'fixture' }),
    getForModel: () => provider, getModelRegistryRevision: () => revision } as unknown as PostalProviders;
  const port: JudgmentPort = { model: 'fixture', async ask(request) {
    const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: wrong ? 0.9 : 0.01 }]));
    return { answers, model: 'fixture', requestedModel: 'fixture', requestId: undefined, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } } as never;
  } };
  previous = installJudgmentPort(port); installed = true;
  const reader = createProfilePostalReader(store, () => config.get('profile.consumerFallback'), providers);
  config.attachProfilePostalFallback(reader);
  return { store, config, reader, calls: () => calls, replaceModel: () => { revision += 2; }, reject: () => { wrong = true; } };
}

describe('prepared profile postal readings', () => {
  test('UK source is proposed and all populated/absent fields are verified; stored config wins', async () => {
    const f = fixture(); f.config.set('payments.shippingAddress.name', 'Owner');
    const prepared = await f.config.preparePostalAddress('shipping');
    expect(prepared.value?.name).toBe('Owner');
    expect(prepared.value?.line1).toBe('10 Downing St');
    expect(prepared.value?.postalCode).toBe('SW1A 2AA');
    expect(f.calls()).toBe(1); prepared.assertCurrent();
    expect(f.config.getRaw().payments.shippingAddress.postalCode).toBe('');
  });
  test('same-content reload and configuration ABA retire prepared values', async () => {
    const f = fixture(); const first = await f.config.preparePostalAddress('shipping');
    f.store.loadSync(); expect(first.assertCurrent).toThrow();
    const second = await f.config.preparePostalAddress('shipping');
    f.config.set('profile.consumerFallback', false); f.config.set('profile.consumerFallback', true);
    expect(second.assertCurrent).toThrow(PostalAddressHeldError);
  });
  test('provider incarnation changes retire already verified values', async () => {
    const f = fixture(); const prepared = await f.config.preparePostalAddress('shipping');
    f.replaceModel(); expect(prepared.assertCurrent).toThrow();
  });
  test('verifier rejection is held, never a missing address', async () => {
    const f = fixture(); f.reject(); await expect(f.config.preparePostalAddress('shipping')).rejects.toThrow(PostalAddressHeldError);
  });
  test('missing billing is null and never invokes a producer', async () => {
    const f = fixture(); expect((await f.config.preparePostalAddress('billing')).value).toBeNull(); expect(f.calls()).toBe(0);
  });
  test('cancelled caller cannot generate and held UI row is explicit', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.reader('shipping', { signal: controller.signal })).rejects.toThrow(PostalAddressHeldError);
    expect(f.calls()).toBe(0);
    const display = readConfigSettingForDisplay(() => { throw new PostalAddressHeldError(); });
    expect(display.value).toBeUndefined(); expect(display.held).toBeDefined();
  });
});
