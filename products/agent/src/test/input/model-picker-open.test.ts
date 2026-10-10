import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
/**
 * The model picker opens at once on the cached catalog and fills in the slow
 * reads (credential sources, the live model re-check) afterwards, with a muted "loading catalog…" row meanwhile. The open never
 * waits on those reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ModelPickerModal, type ModelPickerTargetInfo } from '../../input/model-picker.ts';
import { openModelPickerNow, type ModelPickerOpenDeps } from '../../input/model-picker-open.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { linesToText } from '../setup.ts';

function model(id: string, provider: string, displayName: string): ModelDefinition {
  return {
    id, provider, displayName, registryKey: `${provider}:${id}`, description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128_000, selectable: true, tier: 'premium',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makePicker(): ModelPickerModal {
  return new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null },
  );
}

const target: ModelPickerTargetInfo = { target: 'main', label: 'Main Chat', description: '', provider: 'openai', model: 'openai:gpt-a', enabled: true, inherited: false };

function setup() {
  const picker = makePicker();
  const secrets = deferred<ReadonlySet<string>>();
  const live = deferred<boolean>();
  let catalog: ModelDefinition[] = [model('gpt-a', 'openai', 'GPT A'), model('claude-b', 'anthropic', 'Claude B')];
  const events: string[] = [];
  const deps: ModelPickerOpenDeps = {
    picker,
    modalOpened: () => events.push('opened'),
    render: () => events.push('render'),
    listModels: () => catalog,
    listProviders: () => [...new Set(catalog.map((m) => m.provider))],
    currentModelId: () => 'gpt-a',
    currentProviderId: () => 'openai',
    configuredProviderIds: () => new Set(['openai', 'anthropic', 'moonshot']),
    buildConfiguredVia: (ids, _configured, secretIds) => new Map(ids.map((id) => [id, secretIds.has(id) ? 'secrets' : 'env'] as const)),
    buildTargets: () => [target],
    resolveSecretProviderIds: () => secrets.promise,
    refreshLiveModels: () => live.promise,
    onError: (error) => events.push(`error:${String(error)}`),
  };
  return { picker, deps, secrets, live, events, setCatalog: (next: ModelDefinition[]) => { catalog = next; } };
}

const screen = (picker: ModelPickerModal): string => linesToText(frameFromLayer(renderModelWorkspace(picker, 132, 34), 132, 34)).join('\n');

describe('openModelPickerNow', () => {
  let previousPort: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previousPort = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'Other', 0.99)).port);
  });
  afterEach(() => { installJudgmentPort(previousPort); });

  test('the modal is open and visible before any slow read resolves, with a loading row', () => {
    const { picker, deps, events } = setup();
    void openModelPickerNow(deps);
    // Synchronously after the call: opened, rendered, rows from the cached catalog.
    expect(picker.active).toBe(true);
    expect(events.slice(0, 2)).toEqual(['opened', 'render']);
    expect(picker.catalogLoading).toBe(true);
    const text = screen(picker);
    expect(text).toContain('GPT A');
    expect(text).toContain('Claude B');
    expect(text).toContain('loading catalog…');
  });

  test('rows fill in when the reads land, the selection stays put, and the loading row goes', async () => {
    const { picker, deps, secrets, live, setCatalog } = setup();
    const done = openModelPickerNow(deps);
    picker.selectedIndex = picker.getFilteredModels().findIndex((m) => m.id === 'claude-b');
    secrets.resolve(new Set(['anthropic']));
    setCatalog([model('gpt-a', 'openai', 'GPT A'), model('claude-b', 'anthropic', 'Claude B'), model('kimi-c', 'moonshot', 'Kimi C')]);
    live.resolve(true);
    await done;
    expect(picker.catalogLoading).toBe(false);
    expect(picker.configuredViaMap.get('anthropic')).toBe('secrets');
    expect(picker.getFilteredModels()[picker.selectedIndex]!.id).toBe('claude-b');
    const text = screen(picker);
    expect(text).toContain('Kimi C');
    expect(text).not.toContain('loading catalog…');
  });

  test('closing the picker before the reads land drops them', async () => {
    const { picker, deps, secrets, live } = setup();
    const done = openModelPickerNow(deps);
    picker.close();
    secrets.resolve(new Set(['anthropic']));
    live.resolve(false);
    await done;
    expect(picker.active).toBe(false);
    expect(picker.configuredViaMap.get('anthropic')).not.toBe('secrets');
    expect(picker.catalogLoading).toBe(false);
  });

  test('a failed read reports once and clears the loading row; the picker stays usable', async () => {
    const { picker, deps, live, events } = setup();
    const done = openModelPickerNow({ ...deps, resolveSecretProviderIds: () => Promise.reject(new Error('keyring locked')) });
    live.resolve(false);
    await done;
    expect(picker.active).toBe(true);
    expect(picker.catalogLoading).toBe(false);
    expect(events.filter((e) => e.startsWith('error:'))).toEqual(['error:Error: keyring locked']);
    expect(screen(picker)).toContain('GPT A');
  });

  test('a close and a reopen before the first load lands leaves the new open\'s loading state alone', async () => {
    const first = setup();
    const done = openModelPickerNow(first.deps);
    first.picker.close();
    first.picker.openAllModels([model('gpt-a', 'openai', 'GPT A')], 'gpt-a');
    first.secrets.resolve(new Set(['openai']));
    first.live.resolve(false);
    await done;
    // The reopen above did not go through openModelPickerNow: the stale load must not decorate it.
    expect(first.picker.configuredViaMap.get('openai')).not.toBe('secrets');
  });

  test('the provider list opens the same way', () => {
    const { picker, deps } = setup();
    void openModelPickerNow(deps, 'providers');
    expect(picker.mode).toBe('provider');
    expect(picker.catalogLoading).toBe(true);
    expect(screen(picker)).toContain('loading catalog…');
  });
  test('family completion preserves query and selection and is reused on repeated opens', async () => {
    const gate = deferred<void>();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) { await gate.promise; return fixture.port.ask(request); } });
    const h = setup();
    h.secrets.resolve(new Set());

    h.live.resolve(false);
    const done = openModelPickerNow(h.deps);
    h.picker.groupBy = 'family';
    h.picker.query = 'GPT';
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Ungrouped']);
    gate.resolve();
    await done;
    expect(h.picker.query).toBe('GPT');
    expect(h.picker.getFilteredModels()[h.picker.selectedIndex]?.id).toBe('gpt-a');
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Llama']);
    const count = fixture.requests.length;
    await openModelPickerNow(h.deps);
    expect(fixture.requests).toHaveLength(count);
  });

  test('late family completion cannot repaint a closed or replacement picker', async () => {
    const gate = deferred<void>();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'GPT', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) { await gate.promise; return fixture.port.ask(request); } });
    const h = setup();
    h.secrets.resolve(new Set());

    h.live.resolve(false);
    const done = openModelPickerNow(h.deps);
    // Let all non-family work finish before replacing the modal's ownership.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.picker.close();
    const replacement = model('replacement', 'openai', 'Replacement');
    h.picker.openAllModels([replacement], replacement.id);
    h.picker.query = 'replacement';
    const eventCount = h.events.length;
    gate.resolve();
    await done;
    expect(h.events).toHaveLength(eventCount);
    expect(h.picker.models).toEqual([replacement]);
    expect(h.picker.query).toBe('replacement');
  });

  test('failed or missing family readings keep the catalog usable and do not invent families', async () => {
    for (const port of [undefined, { ...fakePort(() => { throw new Error('family offline'); }).port }]) {
      installJudgmentPort(port);
      const h = setup();
      h.secrets.resolve(new Set());

      h.live.resolve(false);
      await openModelPickerNow(h.deps);
      h.picker.groupBy = 'family';
      expect(h.picker.catalogLoading).toBe(false);
      expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Ungrouped']);
      expect(h.events.some((event) => event.startsWith('error:'))).toBe(true);
    }
  });

  test('a new open joins pending families and owns the resulting repaint', async () => {
    const gate = deferred<void>();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) { await gate.promise; return fixture.port.ask(request); } });
    const h = setup();
    h.secrets.resolve(new Set());

    h.live.resolve(false);
    const first = openModelPickerNow(h.deps);
    const second = openModelPickerNow(h.deps);
    h.picker.groupBy = 'family';
    gate.resolve();
    await Promise.all([first, second]);
    expect(fixture.requests).toHaveLength(2);
    expect(h.picker.catalogLoading).toBe(false);
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Llama']);
  });

  test('live catalog replacement is judged separately while an old family is still pending', async () => {
    const gate = deferred<void>();
    const fixture = fakePort((_name, question, state) => choiceAnswer(question,
      (state as unknown as { displayName: string }).displayName === 'Replacement' ? 'Llama' : 'GPT', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { displayName: string }).displayName !== 'Replacement') await gate.promise;
      return fixture.port.ask(request);
    } });
    const h = setup();
    h.secrets.resolve(new Set());

    const done = openModelPickerNow(h.deps);
    h.picker.groupBy = 'family';
    h.setCatalog([model('gpt-a', 'openai', 'Replacement')]);
    h.live.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.picker.models[0]?.displayName).toBe('Replacement');
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Llama']);
    gate.resolve();
    await done;
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Llama']);
  });

  test('one failed family does not strand a pending sibling or its repaint', async () => {
    const gate = deferred<void>();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { id: string }).id === 'gpt-a') throw new Error('one model offline');
      await gate.promise;
      return fixture.port.ask(request);
    } });
    const h = setup();
    h.secrets.resolve(new Set());

    h.live.resolve(false);
    let settled = false;
    const done = openModelPickerNow(h.deps).then(() => { settled = true; });
    h.picker.groupBy = 'family';
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label)).toEqual(['Ungrouped']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    gate.resolve();
    await done;
    expect(h.picker.getItems().filter((item) => item.isGroupHeader).map((item) => item.label).sort()).toEqual(['Llama', 'Ungrouped']);
    expect(h.events.filter((event) => event.startsWith('error:'))).toHaveLength(1);
  });

});
