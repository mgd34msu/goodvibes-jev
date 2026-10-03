import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../../agent/routine-registry.ts';
import { listAgentRuntimeProfiles, readAgentRuntimeProfileSelection, resolveAgentRuntimeProfileHome } from '../../../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '../../../agent/skill-registry.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../../config/surface.ts';
import { SecretsManager } from '../../../config/secrets.ts';
import {
  applyOnboardingRequest,
  collectOnboardingSnapshot,
  deriveReopenEditAcknowledgementState,
  readOnboardingCheckMarker,
  verifyOnboardingRequest,
} from '../../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

describe('onboarding apply and verify helpers', () => {
  let root: string;
  let configManager: ConfigManager;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = makeProjectTempDir('gv-onboarding-apply');
    shellPaths = createShellPathService({
      workingDirectory: join(root, 'workspace'),
      homeDirectory: join(root, 'home'),
    });
    configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      homeDir: join(root, 'home'),
      workingDir: join(root, 'workspace'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('applies project onboarding settings and acknowledgements with verification', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
          scope: 'project' as const,
        },
        {
          kind: 'acknowledge' as const,
          target: 'providers' as const,
          acknowledged: true,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(applied.ok).toBe(true);
    expect(applied.errors).toEqual([]);
    expect(configManager.get('display.stream')).toBe(false);

    const projectSettingsPath = shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json');
    const globalSettingsPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json');
    const projectSettings = JSON.parse(readFileSync(projectSettingsPath, 'utf-8')) as Record<string, unknown>;

    expect(projectSettings).toMatchObject({
      display: {
        stream: false,
      },
    });
    expect(existsSync(globalSettingsPath)).toBe(false);

    const verification = await verifyOnboardingRequest(
      {
        clock: () => 200,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(verification.ok).toBe(true);
    expect(verification.items.map((item) => item.status)).toEqual(['pass', 'pass']);
  });

  test('creates an isolated Agent profile from onboarding starter selection', async () => {
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'create-agent-profile' as const,
          name: 'research-desk',
          templateId: 'research',
        },
        {
          kind: 'select-agent-profile' as const,
          name: 'research-desk',
        },
      ],
    };

    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
    };
    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);
    const profile = listAgentRuntimeProfiles(shellPaths.homeDirectory).find((entry) => entry.id === 'research-desk');
    const selection = readAgentRuntimeProfileSelection(shellPaths.homeDirectory);

    expect(applied.ok).toBe(true);
    expect(applied.applied).toContainEqual({
      kind: 'create-agent-profile',
      summary: 'Created Agent profile research-desk from research.',
    });
    expect(applied.applied).toContainEqual({
      kind: 'select-agent-profile',
      summary: 'Selected Agent profile research-desk for later plain goodvibes-agent runs.',
    });
    expect(verification.ok).toBe(true);
    expect(profile?.starterTemplateId).toBe('research');
    expect(selection?.id).toBe('research-desk');
    expect(selection?.exists).toBe(true);
    expect(existsSync(join(resolveAgentRuntimeProfileHome(shellPaths.homeDirectory, 'research-desk').homeDirectory, 'profile.json'))).toBe(true);
  });

  test('refuses to overwrite an existing Agent profile during onboarding', async () => {
    const existing = resolveAgentRuntimeProfileHome(shellPaths.homeDirectory, 'research-desk');
    rmSync(existing.homeDirectory, { recursive: true, force: true });
    await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [{ kind: 'create-agent-profile', name: 'research-desk', templateId: 'research' }],
      },
    );

    const second = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [{ kind: 'create-agent-profile', name: 'research-desk', templateId: 'research' }],
      },
    );

    expect(second.ok).toBe(false);
    expect(second.applied).toEqual([]);
    expect(second.errors.map((error) => error.message).join('\n')).toContain('Agent profile already exists: research-desk');
  });

  test('creates local personas, skills, and routines during Agent onboarding', async () => {
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'create-local-persona' as const,
          name: 'Household Operator',
          description: 'Coordinates day-to-day operator work.',
          body: 'Stay serial, proactive, and concise.',
          activate: true,
        },
        {
          kind: 'create-local-skill' as const,
          name: 'Daily Briefing',
          description: 'Summarizes priorities and blockers.',
          procedure: 'Inspect tasks, approvals, and current priorities before asking follow-ups.',
          enabled: true,
        },
        {
          kind: 'create-local-routine' as const,
          name: 'Evening Reset',
          description: 'Closes the day cleanly.',
          steps: 'Review unfinished work, pending approvals, and tomorrow priorities.',
          enabled: true,
        },
      ],
    };
    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
    };

    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);
    const personas = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    const skills = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot();
    const routines = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot();

    expect(applied.ok).toBe(true);
    expect(applied.applied.map((operation) => operation.kind)).toEqual([
      'create-local-persona',
      'create-local-skill',
      'create-local-routine',
    ]);
    expect(verification.ok).toBe(true);
    expect(personas.activePersona?.name).toBe('Household Operator');
    expect(skills.enabledSkills.map((skill) => skill.name)).toContain('Daily Briefing');
    expect(routines.enabledRoutines.map((routine) => routine.name)).toContain('Evening Reset');
  });

  test('rejects partial local behavior setup before writing any local registry', async () => {
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'create-local-persona' as const,
          name: 'Incomplete Persona',
          description: '',
          body: 'Has instructions but no description.',
          activate: true,
        },
        {
          kind: 'create-local-skill' as const,
          name: 'Should Not Persist',
          description: 'Would be valid if the first operation passed.',
          procedure: 'Do not write this when prevalidation fails.',
          enabled: true,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(applied.errors.map((error) => error.message).join('\n')).toContain('Persona description is required.');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).list()).toEqual([]);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).list()).toEqual([]);
  });

  test('prevalidates all config operations before mutating settings', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
        {
          kind: 'set-config' as const,
          key: 'surfaces.webhook.timeoutMs' as const,
          value: 999,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('does not touch check markers when settings verification fails', async () => {
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
      ],
    };
    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: {
          get: ((key: Parameters<ConfigManager['get']>[0]) => {
            if (key === 'display.stream') return true;
            throw new Error(`Unexpected config get in verification-failure test: ${key}`);
          }) as ConfigManager['get'],
          getRaw: configManager.getRaw.bind(configManager),
          load: configManager.load.bind(configManager),
          setDynamic: configManager.setDynamic.bind(configManager),
          getCategory: configManager.getCategory.bind(configManager),
          mergeCategory: configManager.mergeCategory.bind(configManager),
        },
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    const marker = readOnboardingCheckMarker(shellPaths, 'project');
    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(applied.errors.map((error) => error.message).join('\n')).toContain('verify config:display.stream');
    expect(marker.exists).toBe(false);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('stores wizard secrets through SecretsManager without runtime auth ownership', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
          value: 'xoxb-secret',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'surfaces.slack.botToken' as const,
          value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
        },
      ],
    };

    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
      secrets,
    };
    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);

    expect(applied.ok).toBe(true);
    expect(verification.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('xoxb-secret');
    expect(configManager.get('surfaces.slack.botToken')).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN');
  });

  test('applies secret storage policy before secrets entered in the same wizard run', async () => {
    configManager.set('storage.secretPolicy', 'require_secure');
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_POLICY_ORDER_SECRET',
          value: 'secret-value',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'storage.secretPolicy' as const,
          value: 'plaintext_allowed',
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
        secrets,
      },
      request,
    );

    expect(applied.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_POLICY_ORDER_SECRET')).toBe('secret-value');
    expect(configManager.get('storage.secretPolicy')).toBe('plaintext_allowed');
  });

  test('verifies set-secret operations that store GoodVibes secret refs by resolution', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    await secrets.set('GOODVIBES_INNER_SECRET', 'inner-value', { scope: 'project', medium: 'secure' });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_OUTER_SECRET',
          value: 'goodvibes://secrets/goodvibes/GOODVIBES_INNER_SECRET',
          scope: 'project' as const,
          medium: 'secure' as const,
        },
      ],
    };
    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
      secrets,
    };

    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);

    expect(applied.ok).toBe(true);
    expect(verification.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_OUTER_SECRET')).toBe('inner-value');
  });

  test('blocks copied runtime auth user onboarding before applying later operations', async () => {
    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'goodvibes-admin',
            password: 'wizard-pass',
            roles: ['admin'],
            createSession: true,
            retireBootstrapCredential: true,
          },
          {
            kind: 'set-config',
            key: 'display.stream',
            value: false,
          },
        ],
      },
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(applied.errors.map((error) => error.message).join('\n')).toContain(
      'Runtime auth user/session administration is external to GoodVibes Agent onboarding.',
    );
    expect(configManager.get('display.stream')).toBe(true);

    const verification = await verifyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'goodvibes-admin',
            password: 'wizard-pass',
            roles: ['admin'],
            createSession: true,
            retireBootstrapCredential: true,
          },
        ],
      },
    );

    expect(verification.ok).toBe(false);
    expect(verification.items[0]?.message).toContain(
      'Runtime auth user/session administration is external to GoodVibes Agent onboarding.',
    );
  });

  test('rolls back earlier secret writes when a later apply operation fails', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_ROLLBACK_SECRET',
          value: 'secret-value',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: {
          get: configManager.get.bind(configManager),
          getRaw: configManager.getRaw.bind(configManager),
          load: configManager.load.bind(configManager),
          setDynamic: () => {
            throw new Error('simulated config write failure');
          },
          getCategory: configManager.getCategory.bind(configManager),
          mergeCategory: configManager.mergeCategory.bind(configManager),
        },
        shellPaths,
        acknowledgementScope: 'project',
        secrets,
      },
      request,
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(await secrets.get('GOODVIBES_ROLLBACK_SECRET')).toBeNull();
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('round-trips persisted acknowledgement state back into reopen hydration', async () => {
    await applyOnboardingRequest(
      {
        clock: () => 10,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'reopen',
        source: 'wizard',
        operations: [
          {
            kind: 'acknowledge',
            target: 'providers',
            acknowledged: true,
          },
        ],
      },
    );

    const snapshot = await collectOnboardingSnapshot({
      clock: () => 20,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project',
      subscriptions: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => ({
          policy: 'preferred_secure',
          secureAvailable: false,
          storedKeys: 1,
          envBackedKeys: 1,
          secureKeys: 0,
          plaintextKeys: 0,
          warnings: [],
          locations: [],
        }),
        listDetailed: async () => ([
          {
            key: 'OPENAI_API_KEY',
            source: 'env',
            scope: 'env',
            secure: false,
            overriddenByEnv: false,
          },
        ]),
      },
      auth: {
        inspect: () => ({
          userStorePath: '/tmp/auth-users.json',
          bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
          persisted: true,
          bootstrapCredentialPresent: false,
          userCount: 0,
          sessionCount: 0,
          users: [],
          sessions: [],
        }),
      },
      services: {
        getAll: () => ({
          openai: {
            name: 'openai',
            providerId: 'openai',
            authType: 'api-key',
            tokenKey: 'OPENAI_API_KEY',
          },
        }),
        inspect: async () => ({
          config: {
            name: 'openai',
            providerId: 'openai',
            authType: 'api-key',
            tokenKey: 'OPENAI_API_KEY',
          },
          hasPrimaryCredential: true,
          hasPasswordCredential: false,
          hasWebhookUrl: false,
          hasSigningSecret: false,
          hasPublicKey: false,
          hasAppToken: false,
          hasAuthTokenCredential: false,
        }),
      },
    });

    expect(snapshot.acknowledgements.accepted.providers).toBe(true);

    expect(deriveReopenEditAcknowledgementState(snapshot).providers).toEqual({
      required: true,
      accepted: true,
      reason: 'configured-routing',
      detail: '1 provider auth path(s) are already configured.',
    });
  });
});
