import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { buildCliStatusSnapshot, renderCliStatus } from '../../cli/status.ts';
import { PERMISSION_MODE_OPTIONS } from '../../input/onboarding/onboarding-wizard-constants.ts';
import { handleDoctorSubcommand } from '../../cli/doctor.ts';
import type { GoodVibesCliOutputFormat } from '@goodvibes-jev/engine/terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeOptions(root: string, subcommand: string, args: string[], outputFormat: GoodVibesCliOutputFormat = 'text') {
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  return { configManager, subcommand, args, workingDirectory: root, homeDirectory: root, outputFormat };
}

describe('goodvibes doctor subcommands', () => {
  let root = '';
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    root = makeProjectTempDir('gv-doctor');
    previous = installJudgmentPort(fakePort(() => { throw new Error('Permission explanation must not call Jev'); }).port);
  });
  afterEach(() => { installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });

  test('unknown subcommand returns null so the classic doctor renders', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'nonsense', []));
    expect(result).toBeNull();
  });

  test('explanations use explicit permission policy without a semantic approval reading', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'explain', ['read', './unlisted.ts']));
    expect(result?.output).toContain('Decision: ALLOW');
  });

  test('routing lists the conversation role and its config keys', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'routing', []));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('Conversation (main model)');
    expect(result!.output).toContain('provider.model');
    expect(result!.output).toContain('Helper');
    expect(result!.output).toContain('Tool LLM');
  });

  test('explain: read tool in prompt mode is ALLOWED without a prompt', async () => {
    const opts = makeOptions(root, 'explain', ['read', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('config_policy');
  });

  test('explain: write tool in the legacy prompt mode runs automatically', async () => {
    const opts = makeOptions(root, 'explain', ['write', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('config_policy');
    expect(result!.output).toContain('DECIDED HERE');
  });

  test('explain: a shell command in plan mode is DENIED with the plan-mode reason', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'plan');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: DENY');
    expect(result!.output).toContain('plan_mode');
    // A bare shell command is routed through the exec tool.
    expect(result!.output).toContain('exec');
  });

  test('explain: allow-all explains an authorized command without executing it', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x']);
    opts.configManager.set('permissions.mode', 'allow-all');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('config_policy');
  });

  test('automatic permission decisions agree with status JSON and onboarding', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x'], 'json');
    opts.configManager.set('permissions.mode', 'allow-all');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const actual = JSON.parse(result!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.sourceLayer).toBe('config_policy');
    expect(actual.permissionEvaluated).toBe(true);
    const status = JSON.parse(renderCliStatus(opts));
    expect(status.auth.permissionLabel).toBe('Allow all configured actions');
    expect(status.auth.permissionDetail).toContain('without an approval prompt');
    expect(status.auth.permissionDetail).toContain('authority');
    const option = PERMISSION_MODE_OPTIONS.find(option => option.id === 'allow-all')!;
    expect(option.label).toBe(status.auth.permissionLabel);
    expect(option.hint).toContain('without an approval prompt');
    expect(option.hint).toContain('authority');
  });

  test('auto-approve status describes automatic actions and configured constraints', async () => {
    const opts = makeOptions(root, 'explain', ['fixture-post'], 'json');
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.sourceLayer).toBe('config_policy');
    expect(actual.permissionEvaluated).toBe(true);
    const snapshot = buildCliStatusSnapshot(opts);
    expect(snapshot.auth.permissionLabel).toContain('Auto-approve ON');
    expect(snapshot.auth.permissionDetail).toContain('authority');
    expect(snapshot.findings.some(f => f.id === 'auto-approve-permissions' && f.severity === 'risk')).toBe(true);
  });

  test('auto-approve override is reported instead of promising the underlying preset will ask', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x'], 'json');
    opts.configManager.set('permissions.mode', 'allow-all');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.permissionEvaluated).toBe(true);
    const snapshot = buildCliStatusSnapshot(opts);
    expect(snapshot.auth.permissionLabel).toContain('Auto-approve ON');
    expect(snapshot.auth.permissionDetail).toContain('authority');
    expect(snapshot.findings.find(f => f.id === 'allow-all-permissions')?.impact).toContain('without an approval prompt');
  });

  test('explain: allow-all permits a below-critical destructive project call', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'allow-all');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('HIGH');
  });

  test('an automatic allowance is attributed to the configured policy in JSON and text', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'allow-all');
    opts.configManager.set('behavior.autoApprove', false);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.sourceLayer).toBe('config_policy');
    expect(actual.reasonCode).toBe('config_allow');
    expect(actual.decidedLayer).toBe('Configured permission policy');
    expect(actual.because).toContain('configured permission policy');
    const text = (await handleDoctorSubcommand({ ...opts, outputFormat: 'text' }))!.output;
    expect(text).toContain('Configured permission policy');
    expect(text).toContain('DECIDED HERE');
    expect(text).not.toContain('Layers walked');
    expect(text).not.toContain('every tool call is auto-approved');
  });

  test('a configured custom denial remains authoritative with auto-approve enabled', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'custom');
    opts.configManager.set('permissions.tools.exec', 'deny');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('DENY');
    expect(actual.sourceLayer).toBe('config_policy');
    expect(actual.decidedLayer).toBe('Configured permission policy');
    expect(actual.reasonCode).toBe('config_deny');
    expect(actual.because).toContain('deny');
    expect(actual.because).not.toContain('permissions.tools.exec is set to "allow"');
  });

  test('explain: json output carries the authoritative verdict and layers', async () => {
    const opts = makeOptions(root, 'explain', ['write', './a.ts'], 'json');
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const parsed = JSON.parse(result!.output) as { verdict: string; sourceLayer: string; reasonCode: string };
    expect(parsed.verdict).toBe('ALLOW');
    expect(parsed.sourceLayer).toBe('config_policy');
  });

  test('hooks: lists registered hooks with their source and flags an unknown event point', async () => {
    const hooksPath = join(root, 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        'Pre:tool:*': [{ name: 'guard', match: 'Pre:tool:*', type: 'command', command: 'echo hi' }],
        'Pre:bogus:thing': [{ name: 'bad', match: 'Pre:bogus:thing', type: 'command', command: 'echo x' }],
      },
    }), 'utf-8');
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', hooksPath);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(1);
    expect(result!.output).toContain('[PASS] Pre:tool:*');
    expect(result!.output).toContain('[FAIL] Pre:bogus:thing');
    expect(result!.output).toContain(hooksPath);
    expect(result!.output).toContain('not a recognized hook event point');
  });

  test('hooks: reports an absent hooks file honestly', async () => {
    const opts = makeOptions(root, 'hooks', []);
    opts.configManager.set('tools.hooksFile', join(root, 'nope.json'));
    const result = await handleDoctorSubcommand(opts);
    expect(result!.exitCode).toBe(0);
    expect(result!.output).toContain('no hooks file present');
  });
});
