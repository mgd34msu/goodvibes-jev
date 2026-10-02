import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
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
    previous = installJudgmentPort(fakePort((name, _question, state) => {
      const input = state as { tool?: string; arguments?: unknown; workingDirectory?: string };
      // Authored facts for these explanation-only calls; verdicts still come from the real gate/preset.
      const read = { mutates: 0.01, outward: 0.01, secrets: 0.01, kind: 'read', family: 'generic', irreversible: 0.01, beyondProject: 0.01, weakensSecurity: 0.01, catastrophic: 0.01, cardDetails: 0.01 };
      const write = { ...read, mutates: 0.99, kind: 'write', family: 'file-mutation' };
      const remove = { ...read, mutates: 0.99, kind: 'shell', family: 'shell-destructive', irreversible: 0.99, obfuscated: 0.01 };
      const fixtures: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
        'read:{"path":"./src/x.ts"}': read,
        'write:{"path":"./src/x.ts"}': write,
        'write:{"path":"./a.ts"}': write,
        'exec:{"command":"rm -rf build"}': remove,
        'exec:{"command":"fixture-post"}': { ...read, mutates: 0.99, outward: 0.99, kind: 'shell', family: 'network-egress', obfuscated: 0.01, cardDetails: 0.5 },
        'exec:{"command":"rm -rf /tmp/x"}': { ...remove, beyondProject: 0.99 },
      };
      const facts = input.workingDirectory === root ? fixtures[`${input.tool}:${JSON.stringify(input.arguments)}`] : undefined;
      const reading = facts && Object.hasOwn(facts, name) ? facts[name] : undefined;
      if (reading === undefined) throw new Error(`Unexpected doctor fixture question: ${name}`);
      return typeof reading === 'string' ? choiceAnswer(_question, reading, 0.99) : noulAnswer(reading);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });

  test('unknown subcommand returns null so the classic doctor renders', async () => {
    const result = await handleDoctorSubcommand(makeOptions(root, 'nonsense', []));
    expect(result).toBeNull();
  });

  test('explanation fixtures reject unlisted tool arguments rather than guessing', async () => {
    await expect(handleDoctorSubcommand(makeOptions(root, 'explain', ['read', './unlisted.ts']))).rejects.toThrow('Unexpected doctor fixture question');
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

  test('explain: write tool in prompt mode reaches the approval prompt (ASK)', async () => {
    const opts = makeOptions(root, 'explain', ['write', './src/x.ts']);
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ASK');
    expect(result!.output).toContain('user_prompt');
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

  test('explain: allow-all still asks for critical outside-project destruction', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x']);
    opts.configManager.set('permissions.mode', 'allow-all');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ASK');
    expect(result!.output).toContain('CRITICAL');
    expect(result!.output).toContain('user_prompt');
  });

  test('critical gate ASK agrees with status JSON and onboarding rather than promising bypass', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', '/tmp/x'], 'json');
    opts.configManager.set('permissions.mode', 'allow-all');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const actual = JSON.parse(result!.output);
    expect(actual.verdict).toBe('ASK');
    expect(actual.sourceLayer).toBe('user_prompt');
    expect(actual.permissionEvaluated).toBe(true);
    const status = JSON.parse(renderCliStatus(opts));
    expect(status.auth.permissionLabel).toBe('Automatic below critical stakes');
    expect(status.auth.permissionDetail).toContain('critical calls still ask');
    expect(status.auth.permissionDetail).toContain('boundary');
    const option = PERMISSION_MODE_OPTIONS.find(option => option.id === 'allow-all')!;
    expect(option.label).toBe(status.auth.permissionLabel);
    expect(option.hint).toContain('critical calls still ask');
    expect(option.hint).toContain('boundary');
  });

  test('auto-approve status preserves its warning and acknowledges a real boundary prompt', async () => {
    const opts = makeOptions(root, 'explain', ['fixture-post'], 'json');
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ASK');
    expect(actual.sourceLayer).toBe('user_prompt');
    expect(actual.permissionEvaluated).toBe(true);
    const snapshot = buildCliStatusSnapshot(opts);
    expect(snapshot.auth.permissionLabel).toContain('Auto-approve ON');
    expect(snapshot.auth.permissionDetail).toContain('boundary');
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
    expect(snapshot.auth.permissionDetail).toContain('boundary');
    expect(snapshot.findings.find(f => f.id === 'allow-all-permissions')?.impact).not.toContain('critical calls still ask');
  });

  test('explain: allow-all permits a below-critical destructive project call', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build']);
    opts.configManager.set('permissions.mode', 'allow-all');
    const result = await handleDoctorSubcommand(opts);
    expect(result!.output).toContain('Decision: ALLOW');
    expect(result!.output).toContain('HIGH');
  });

  test('a real below-critical preset allowance is attributed to the preset in JSON and text', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'allow-all');
    opts.configManager.set('behavior.autoApprove', false);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.sourceLayer).toBe('stakes_preset');
    expect(actual.reasonCode).toBe('preset_allow');
    expect(actual.decidedLayer).toBe('Stakes preset');
    expect(actual.because).toContain('auto preset returned "allow"');
    expect(actual.because).toContain('high stakes');
    const text = (await handleDoctorSubcommand({ ...opts, outputFormat: 'text' }))!.output;
    expect(text).toContain('Stakes preset   ← DECIDED HERE');
    expect(text).not.toContain('Layers walked');
    expect(text).not.toContain('every tool call is auto-approved');
  });

  test('auto-approve overriding a custom deny is not attributed to a nonexistent custom allow', async () => {
    const opts = makeOptions(root, 'explain', ['rm', '-rf', 'build'], 'json');
    opts.configManager.set('permissions.mode', 'custom');
    opts.configManager.set('permissions.tools.exec', 'deny');
    opts.configManager.set('behavior.autoApprove', true);
    const actual = JSON.parse((await handleDoctorSubcommand(opts))!.output);
    expect(actual.verdict).toBe('ALLOW');
    expect(actual.sourceLayer).toBe('config_policy');
    expect(actual.decidedLayer).toBe('Automatic approval after boundary checks');
    expect(actual.because).toContain('Auto-approve is active');
    expect(actual.because).not.toContain('permissions.tools.exec is set to "allow"');
  });

  test('explain: json output carries the authoritative verdict and layers', async () => {
    const opts = makeOptions(root, 'explain', ['write', './a.ts'], 'json');
    opts.configManager.set('permissions.mode', 'prompt');
    opts.configManager.set('behavior.autoApprove', false);
    const result = await handleDoctorSubcommand(opts);
    const parsed = JSON.parse(result!.output) as { verdict: string; sourceLayer: string; reasonCode: string };
    expect(parsed.verdict).toBe('ASK');
    expect(parsed.sourceLayer).toBe('user_prompt');
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
