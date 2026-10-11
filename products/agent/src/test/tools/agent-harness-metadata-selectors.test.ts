import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { describeHarnessCliCommand, listHarnessCliCommands, totalHarnessCliCommands } from '../../tools/agent-harness-cli-metadata.ts';
import { describeHarnessKeybinding, listHarnessKeybindings, listHarnessShortcuts, runHarnessKeybinding, setHarnessKeybinding, totalHarnessKeybindings, totalHarnessShortcuts } from '../../tools/agent-harness-keybinding-metadata.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { createRequestCountDiagnostics } from '../helpers/judgment-request-count-diagnostics.ts';

const requestDiagnostics = createRequestCountDiagnostics('agent-harness-metadata-selectors');
const installJudgmentPort = requestDiagnostics.installPort;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { requestDiagnostics.beginFixture(); previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); requestDiagnostics.endFixture(); });
afterAll(cleanupResearchScreeningFixtures);
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
const emptyContext = { workspace: {} };

function readings(fits: Readonly<Record<string, number>>) {
  return requestDiagnostics.track(fakePort((name, _question, state) => {
    if (name !== 'match' || state === null || typeof state !== 'object' || !('candidate' in state)
      || state.candidate === null || typeof state.candidate !== 'object' || !('name' in state.candidate)
      || typeof state.candidate.name !== 'string') throw new Error('Unexpected metadata reading');
    return noulAnswer(fits[state.candidate.name] ?? 0.01);
  }), 'readings');
}

async function withManager<T>(fn: (fixture: {
  readonly manager: KeybindingsManager;
  readonly configPath: string;
  readonly context: { readonly workspace: { keybindingsManager: KeybindingsManager }; readonly renderRequest: () => void };
}) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-metadata-selector');
  const configPath = join(root, 'keybindings.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const manager = new KeybindingsManager({ configPath });
  try { return await fn({ manager, configPath, context: { workspace: { keybindingsManager: manager }, renderRequest: () => {} } }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe('canonical CLI and keybinding metadata selectors', () => {
  test('keybinding selection reads the complete catalog before display limits and permits counter-lexical results', async () => {
    const fake = readings({ paste: 0.99 }); installJudgmentPort(fake.port);
    const result = await listHarnessKeybindings(emptyContext, { query: 'conversation search', limit: 1 }, options());
    expect(result.keybindings).toMatchObject([{ action: 'paste', judgment: { reading: { verdict: 'yes' } } }]);
    expect(fake.requests).toHaveLength(totalHarnessKeybindings(emptyContext));
    expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
    expect(await describeHarnessKeybinding(emptyContext, { query: 'conversation search' }, options())).toMatchObject({ action: 'paste', lookup: { resolvedBy: 'search' }, judgment: { reading: { verdict: 'yes' } } });
  });

  test('CLI selection reads every command and uses the canonical rank instead of a description substring', async () => {
    const fake = readings({ doctor: 0.99 }); installJudgmentPort(fake.port);
    const result = await listHarnessCliCommands({ query: 'Call isolated Agent Knowledge routes', limit: 1 }, options());
    expect(result).toMatchObject([{ name: 'doctor', judgment: { reading: { verdict: 'yes' } } }]);
    expect(fake.requests).toHaveLength(totalHarnessCliCommands());
    expect(await describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, options())).toMatchObject({ name: 'doctor', lookup: { resolvedBy: 'search' } });
  });

  test('shortcut prose queries read every fixed and configurable candidate', async () => {
    const fake = readings({ Enter: 0.99 }); installJudgmentPort(fake.port);
    const result = await listHarnessShortcuts(emptyContext, { query: 'runtime activity', limit: 1 }, options());
    expect(result.fixedShortcuts).toMatchObject([{ key: 'Enter', judgment: { reading: { verdict: 'yes' } } }]);
    expect(result.configurableKeybindings).toEqual([]);
    expect(fake.requests).toHaveLength(totalHarnessShortcuts(emptyContext));
  });

  test('one uncertain result remains visible and cannot resolve an executable action', async () => {
    installJudgmentPort(readings({ search: 0.5 }).port);
    expect(await describeHarnessKeybinding(emptyContext, { query: 'conversation search' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ action: 'search' }] });
    installJudgmentPort(readings({ doctor: 0.5 }).port);
    expect(await describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ name: 'doctor' }] });
    installJudgmentPort(readings({ search: 0.5 }).port);
    await withManager(async ({ context }) => {
      const effects: string[] = [];
      const result = await runHarnessKeybinding({ ...context, openConversationSearch: () => { effects.push('opened'); } }, { query: 'conversation search' }, options());
      expect(result.status).toBe('ambiguous'); expect(effects).toEqual([]);
    });
  });

  test('negative readings have no lexical fallback', async () => {
    installJudgmentPort(readings({}).port);
    expect((await listHarnessKeybindings(emptyContext, { query: 'conversation search' }, options())).keybindings).toEqual([]);
    expect(await describeHarnessKeybinding(emptyContext, { query: 'conversation search' }, options())).toBeNull();
    expect(await listHarnessCliCommands({ query: 'Call isolated Agent Knowledge routes' }, options())).toEqual([]);
    expect(await describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, options())).toMatchObject({ supported: false });
  });

  test('a yes reading held by the canonical action floor cannot resolve an executable selector', async () => {
    installJudgmentPort(readings({ search: 0.58 }).port);
    expect(await describeHarnessKeybinding(emptyContext, { query: 'conversation search' }, options())).toMatchObject({
      status: 'ambiguous', candidates: [{ action: 'search', judgment: { reading: { verdict: 'yes', outcome: 'confirm' } } }],
    });
    installJudgmentPort(readings({ doctor: 0.58 }).port);
    expect(await describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, options())).toMatchObject({
      status: 'ambiguous', candidates: [{ name: 'doctor', judgment: { reading: { verdict: 'yes', outcome: 'confirm' } } }],
    });
  });

  test('exact identifiers, exact key-combo grammar and full lists work without hosted judgment or source owner', async () => {
    expect((await listHarnessKeybindings(emptyContext, {})).returned).toBe(totalHarnessKeybindings(emptyContext));
    expect((await listHarnessShortcuts(emptyContext, {})).returned).toBe(totalHarnessShortcuts(emptyContext));
    expect(await listHarnessCliCommands({})).toHaveLength(totalHarnessCliCommands());
    expect(await describeHarnessKeybinding(emptyContext, { actionId: 'SEARCH' })).toMatchObject({ action: 'search', lookup: { resolvedBy: 'case-insensitive-action' } });
    const action = await describeHarnessKeybinding(emptyContext, { actionId: 'search' });
    expect(action).toMatchObject({ modelOperation: { confirmation: 'agent_harness mode:"run_keybinding" requires current recorded Jev effect admission.' } });
    expect(JSON.stringify(action?.modelAccess)).not.toContain('confirm:true');
    expect(JSON.stringify(action?.modelAccess)).not.toContain('explicitUserRequest');
    expect(await describeHarnessKeybinding(emptyContext, { key: 'Ctrl+F' })).toMatchObject({ action: 'search', lookup: { resolvedBy: 'key-combo' } });
    expect(await describeHarnessKeybinding(emptyContext, { actionId: 'conversation search' })).toBeNull();
    expect(await describeHarnessKeybinding(emptyContext, { key: 'Ctrl+Unbound' })).toBeNull();
    const cli = await describeHarnessCliCommand({ cliCommand: 'goodvibes-agent status --json --config surfaces.slack.botToken=synthetic-value' });
    expect(cli).toMatchObject({ name: 'status', lookup: { resolvedBy: 'invocation' }, parsed: { flags: { outputFormat: 'json', configOverrides: ['surfaces.slack.botToken=<redacted>'] } } });
    expect(JSON.stringify(cli)).not.toContain('synthetic-value');
    expect(await describeHarnessCliCommand({ cliCommand: 'daemon start' })).toMatchObject({ supported: false });
    expect(await describeHarnessCliCommand({ commandName: 'KNOWLEDGE' })).toMatchObject({ name: 'knowledge', lookup: { resolvedBy: 'command-name' } });
    expect(await describeHarnessCliCommand({ commandName: 'know' })).toMatchObject({ name: 'knowledge' });
    expect(await describeHarnessCliCommand({ commandName: 'tui' })).toMatchObject({ name: 'tui' });
    expect(await describeHarnessCliCommand({ commandName: 'knowledge routes' })).toMatchObject({ supported: false, status: 'missing_lookup' });
  });

  test('reader unavailability holds semantic requests instead of interpreting them locally', async () => {
    await expect(listHarnessKeybindings(emptyContext, { query: 'conversation search' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
    await expect(listHarnessCliCommands({ query: 'Call isolated Agent Knowledge routes' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('mechanical CLI config custody withholds short flags and quoted values without a hosted reader', async () => {
    for (const flag of ['--config', '-c']) for (const separator of [' ', '=']) {
      const result = await describeHarnessCliCommand({ cliCommand: `goodvibes-agent status ${flag}${separator}surfaces.slack.botToken="synthetic-private value tail"` });
      expect(result).toMatchObject({ name: 'status', parsed: { commandArgs: [], positionals: [], flags: { configOverrides: ['surfaces.slack.botToken=<redacted>'] } } });
      for (const span of ['synthetic-private', 'value tail']) expect(JSON.stringify(result)).not.toContain(span);
      expect(JSON.stringify(result)).toContain('surfaces.slack.botToken=<redacted>');
    }
    const malformed = await describeHarnessCliCommand({ cliCommand: 'status -c synthetic-private-config-value' });
    expect(JSON.stringify(malformed)).not.toContain('synthetic-private-config-value');
    expect(malformed).toMatchObject({ parsed: { flags: { configOverrides: ['<redacted>'] } } });
  });

  test('a changed keybinding source invalidates pending semantic resolution before an owner write', async () => {
    await withManager(async ({ manager, context, configPath }) => {
      const fake = readings({ search: 0.99 });
      installJudgmentPort({ ...fake.port, ask: async request => {
        const result = await fake.port.ask(request);
        writeFileSync(configPath, JSON.stringify({ paste: { key: 'p', alt: true } })); manager.loadFromDisk();
        return result;
      } });
      await expect(setHarnessKeybinding(context, { query: 'conversation search', combo: { key: 'g', ctrl: true } }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ paste: { key: 'p', alt: true } });
    });
  });

  test('cancellation after a provider answer prevents selected result publication', async () => {
    const fake = readings({ doctor: 0.99 }), controller = new AbortController();
    installJudgmentPort({ ...fake.port, ask: async request => { const result = await fake.port.ask(request); controller.abort(new Error('cancel metadata')); return result; } });
    await expect(describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, { ...options(), signal: controller.signal })).rejects.toThrow();
  });

  test('changing original CLI arguments during a reading cannot publish the old result', async () => {
    const fake = readings({ doctor: 0.99 }), args = { query: 'Call isolated Agent Knowledge routes' };
    installJudgmentPort({ ...fake.port, ask: async request => { const result = await fake.port.ask(request); args.query = 'different request'; return result; } });
    await expect(describeHarnessCliCommand(args, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('replacing an acquired currentness callback cannot retire the original authority checks', async () => {
    for (const kind of ['cli', 'keybinding']) {
      const acquired = { ...options(), assertCurrent: () => {} };
      const fake = readings({ doctor: 0.99, paste: 0.99 });
      installJudgmentPort({ ...fake.port, ask: async request => {
        const result = await fake.port.ask(request); acquired.assertCurrent = () => {}; return result;
      } });
      const pending = kind === 'cli' ? describeHarnessCliCommand({ query: 'Call isolated Agent Knowledge routes' }, acquired)
        : describeHarnessKeybinding(emptyContext, { query: 'conversation search' }, acquired);
      await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    }
  });

  test('privacy screening holds redacted full lookup source before any hosted request', async () => {
    const sensitive = 'synthetic-private-owner-profile';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const fake = readings({ doctor: 0.99 }); installJudgmentPort(fake.port);
    await expect(listHarnessCliCommands({ query: `Find ${sensitive}` }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    requestDiagnostics.reportUnexpectedCount(fake, 0, 'private metadata source');
    expect(fake.requests).toHaveLength(0);
    expect(JSON.stringify(screening.calls)).toContain(sensitive);
  });

  test('exact keybindings retain a source guard across final publication without semantic readings', async () => {
    await withManager(async ({ context, manager, configPath }) => {
      const guards: (() => void)[] = [];
      expect(await describeHarnessKeybinding(context, { actionId: 'search' }, { retainCurrent: guard => { guards.push(guard); } })).toMatchObject({ action: 'search' });
      for (const guard of guards) guard();
      writeFileSync(configPath, JSON.stringify({ search: { key: 'g', ctrl: true } })); manager.loadFromDisk();
      expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
    });
  });

  test('accessor-bearing metadata arguments hold without invoking the getter', async () => {
    let touched = 0;
    const args = { get query() { touched++; return 'conversation search'; } };
    await expect(listHarnessKeybindings(emptyContext, args, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(touched).toBe(0);
  });
});
