/** Synthetic canonical readings through the real store and gateway, never live Jev evidence. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods, type OwnerProfileGatewayService } from '../sdk/src/platform/control-plane/routes/owner-profile.ts';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(people = '- Jo is my sister.\n- She spends Saturdays at the pottery wheel.\n- Dave works with Jo.') {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-person-')); roots.push(dir);
  const path = join(dir, 'profile.md');
  const text = `## Identity\nname: Avery Chen\n## People\n${people}\n## Important dates\n- Jo’s birthday · 03-14 · annual\n`;
  writeFileSync(path, text);
  const store = new OwnerProfileStore({ path }); store.loadSync();
  return { store, path, text };
}
function recorded(probability?: number) {
  return fakePort((_name, _question, raw) => {
    const state = raw as { line: string };
    return noulAnswer(probability ?? (state.line === '- Dave works with Jo.' ? 0.01 : 0.99));
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function blocked() {
  const fake = recorded(), entered = deferred(), release = deferred();
  const port: JudgmentPort = { ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } };
  installJudgmentPort(port);
  return { ...fake, port, entered, release };
}
function gateway(store: OwnerProfileStore, afterRead?: () => void, retainBeforeResponse?: () => void) {
  const service: OwnerProfileGatewayService = {
    read: () => store.read(), get: id => store.get(id), provenance: id => store.provenance(id), status: () => store.status(),
    set: input => store.set(input), append: input => store.append(input), forget: input => store.forget(input), undo: input => store.undo(input),
    person: async (name, options) => {
      const lines = await store.person(name, options); afterRead?.();
      if (retainBeforeResponse) options?.retain?.(retainBeforeResponse);
      return lines;
    },
  };
  const catalog = new GatewayMethodCatalog(); registerOwnerProfileGatewayMethods(catalog, service);
  return catalog;
}

 test('the actual battery retains a pronoun line and excludes an incidental name mention', async () => {
  const fake = recorded(); installJudgmentPort(fake.port); const { store } = fixture();
  const lines = await store.person('Jo');
  expect(lines.map(line => line.text)).toEqual(['- Jo is my sister.', '- She spends Saturdays at the pottery wheel.']);
  expect(fake.requests).toHaveLength(3);
  expect(fake.requests.every(request => request.context?.battery === 'engine.owner-profile.person-line')).toBe(true);
  const sent = JSON.stringify(fake.requests.map(request => request.state));
  expect(sent).toContain('Dave works with Jo'); expect(sent).not.toContain('03-14'); expect(sent).not.toContain('Avery Chen');
  expect(store.get('identity.name')?.value).toBe('Avery Chen'); expect(store.section('People')).toBeUndefined();
});
 test('settled no returns no lines; uncertainty and missing port never fall back to text matching', async () => {
  const { store } = fixture();
  await expect(store.person('Jo')).rejects.toThrow();
  installJudgmentPort(recorded(0.01).port); expect(await store.person('Jo')).toEqual([]);
  installJudgmentPort(recorded(0.5).port); await expect(store.person('Jo')).rejects.toThrow();
});
 test('punctuation is a negative structural guard and cannot enumerate People', async () => {
  const { store } = fixture();
  for (const name of ['', '  ', '-', '*', '.']) expect(await store.person(name)).toEqual([]);
});
 test('the complete source is admitted before projection, even excluded provenance', async () => {
  const { store } = fixture();
  const line = store.read().sections.find(section => section.heading === 'People')!.prose[0]!;
  // A synthetic credential assignment in original provenance must not reach the port.
  Object.assign(line, { provenance: { surface: 'tui', at: '2026-01-01', said: 'password=synthetic-secret' } });
  const fake = recorded(); installJudgmentPort(fake.port);
  await expect(store.person('Jo')).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
});
 test('a same-bytes profile reload retires a pending person reading', async () => {
  const h = fixture(), b = blocked(); const pending = h.store.person('Jo'); void pending.catch(() => {});
  await b.entered.promise; h.store.loadSync(); b.release.resolve();
  await expect(pending).rejects.toThrow();
});
 test('an in-place original People mutation retires a pending person reading', async () => {
  const h = fixture(), b = blocked(); const pending = h.store.person('Jo'); void pending.catch(() => {});
  await b.entered.promise;
  Object.assign(h.store.read().sections.find(section => section.heading === 'People')!.prose[0]!, { text: '- Different person.' });
  b.release.resolve(); await expect(pending).rejects.toThrow();
});
 test('caller abort interrupts a non-cooperating port', async () => {
  const { store } = fixture(), b = blocked(), controller = new AbortController();
  const pending = store.person('Jo', { signal: controller.signal }); void pending.catch(() => {});
  await b.entered.promise; controller.abort();
  await expect(pending).rejects.toThrow(); b.release.resolve();
});
 test('port replacement and restoration cannot revive a pending reading', async () => {
  const { store } = fixture(), b = blocked(); const pending = store.person('Jo'); void pending.catch(() => {});
  await b.entered.promise; installJudgmentPort(recorded().port); installJudgmentPort(b.port);
  await expect(pending).rejects.toThrow(); b.release.resolve();
});
 test('malformed answers and requested-model mismatch fail closed', async () => {
  const { store } = fixture(); const fake = recorded();
  installJudgmentPort({ ...fake.port, async ask(request) { const response = await fake.port.ask(request); return { ...response, answers: {} as typeof response.answers }; } });
  await expect(store.person('Jo')).rejects.toThrow();
  installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), requestedModel: 'different-model' }; } });
  await expect(store.person('Jo')).rejects.toThrow();
});
 test('gateway retains the source restriction after the store promise settles', async () => {
  const h = fixture(); installJudgmentPort(recorded().port);
  const catalog = gateway(h.store, () => h.store.loadSync());
  await expect(catalog.invoke('profile.person', { body: { name: 'Jo' }, context: {} })).rejects.toThrow();
});
 test('gateway retains the port restriction after the store promise settles', async () => {
  const h = fixture(); installJudgmentPort(recorded().port);
  const catalog = gateway(h.store, () => { installJudgmentPort(recorded().port); });
  await expect(catalog.invoke('profile.person', { body: { name: 'Jo' }, context: {} })).rejects.toThrow();
});
 test('gateway refuses changed input or caller authorization while reading', async () => {
  for (const change of ['input', 'authorization']) {
    const h = fixture(), b = blocked(), catalog = gateway(h.store);
    let authorized = true; const body = { name: 'Jo' };
    const pending = catalog.invoke('profile.person', { body, context: {}, isAuthorized: () => authorized }); void pending.catch(() => {});
    await b.entered.promise;
    if (change === 'input') body.name = 'Dave'; else authorized = false;
    b.release.resolve(); await expect(pending).rejects.toThrow();
  }
});
 test('gateway validates shadowed original query values before starting a reading', async () => {
  const h = fixture(), fake = recorded(); installJudgmentPort(fake.port);
  await expect(gateway(h.store).invoke('profile.person', { body: { name: 'Jo' }, query: { name: 'password=synthetic-secret' }, context: {} })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});
 test('a returned observation cannot be retained across profile changes', async () => {
  const h = fixture(); installJudgmentPort(recorded().port); const checks: (() => void)[] = [];
  await h.store.person('Jo', { retain: check => { checks.push(check); } });
  expect(checks).toHaveLength(2); for (const check of checks) check(); h.store.loadSync(); for (const check of checks) expect(check).toThrow();
});

 test('gateway rechecks the caller after retained callbacks mutate authorization', async () => {
  const h = fixture(); installJudgmentPort(recorded().port);
  let authorized = true;
  const catalog = gateway(h.store, undefined, () => { authorized = false; });
  await expect(catalog.invoke('profile.person', {
    body: { name: 'Jo' }, context: {}, isAuthorized: () => authorized,
  })).rejects.toThrow();
  expect(authorized).toBe(false);
});
