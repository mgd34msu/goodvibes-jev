import { describe, expect, test } from 'bun:test';
import { buildCliDoctorFindings, renderCliStatus, renderOnboardingCliStatus } from '../../cli/status.ts';
import type { CliStatusOptions } from '../../cli/status.ts';
import type { CliExternalRuntimeSnapshot } from '../../cli/external-runtime.ts';

type ConfigValues = Record<string, unknown>;
type CliStatusService = NonNullable<CliStatusOptions['service']>;

function makeExternalRuntime(overrides: Partial<CliExternalRuntimeSnapshot> = {}): CliExternalRuntimeSnapshot {
  return {
    baseUrl: 'http://127.0.0.1:3421',
    statusCode: 200,
    reachable: true,
    compatible: true,
    operatorToken: {
      present: true,
      path: '/home/test/.goodvibes/daemon/operator-tokens.json',
    },
    agentKnowledge: {
      route: '/api/goodvibes-agent/knowledge/status',
      ready: true,
      kind: 'ok',
      statusCode: 200,
    },
    error: null,
    ...overrides,
  };
}

function makeOptions(overrides: ConfigValues = {}): CliStatusOptions {
  const values: ConfigValues = {
    'provider.provider': 'openai',
    'provider.model': 'openai:gpt-5.4',
    'provider.reasoningEffort': 'high',
    'permissions.mode': 'prompt',
    'storage.secretPolicy': 'preferred_secure',
    'service.enabled': true,
    'service.autostart': true,
    'service.restartOnFailure': true,
    'daemon.enabled': true,
    'danger.httpListener': false,
    'web.enabled': false,
    'controlPlane.enabled': true,
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'httpListener.hostMode': 'local',
    'httpListener.host': '127.0.0.1',
    'httpListener.port': 3422,
    'web.hostMode': 'local',
    'web.host': '127.0.0.1',
    'web.port': 3423,
    ...overrides,
  };

  return {
    configManager: {
      get: (key: string) => values[key],
    } as CliStatusOptions['configManager'],
    workingDirectory: '/project',
    homeDirectory: '/home/test',
    onboardingMarkers: {
      project: { scope: 'project', path: '/project/.goodvibes/agent/onboarding-checked.json', exists: false, payload: null },
      user: { scope: 'user', path: '/home/test/.goodvibes/agent/onboarding-checked.json', exists: false, payload: null },
      effective: null,
    },
    auth: {
      userStorePath: '/home/test/.goodvibes/agent/auth-users.json',
      userStorePresent: true,
      bootstrapCredentialPath: '/home/test/.goodvibes/agent/auth-bootstrap.txt',
      bootstrapCredentialPresent: false,
      operatorTokenPath: '/home/test/.goodvibes/daemon/operator-tokens.json',
      operatorTokenPresent: true,
    },
    externalRuntime: makeExternalRuntime(),
  };
}

function makeServicePosture(overrides: Partial<CliStatusService> = {}): CliStatusService {
  const service: CliStatusService = {
    advisories: [],
    config: {
      enabled: true,
      autostart: true,
      restartOnFailure: true,
      daemonEnabled: true,
      connectedHostDialEnabled: true,
    },
    managed: {
      platform: 'manual',
      path: 'connected GoodVibes host',
      installed: false,
      autostart: false,
      running: false,
      logPath: '/home/test/.goodvibes/daemon/service/manual.log',
      commandPreview: 'managed outside goodvibes-agent',
      suggestedCommands: [],
      lastAction: 'status',
      pidPath: 'connected GoodVibes host',
      lastError: null,
    },
    endpoints: [],
    log: {
      path: '/project/.goodvibes/agent/service/manual.log',
      exists: true,
      size: 128,
      modifiedAt: 1,
    },
    issues: [],
  };
  return { ...service, ...overrides };
}

describe('CLI status and doctor output', () => {
  test('renders operator-friendly labels for permission and secret policies', () => {
    const text = renderCliStatus(makeOptions({
      'permissions.mode': 'allow-all',
      'storage.secretPolicy': 'require_secure',
    }));

    expect(text).toContain('permissions: Allow everything (allow-all)');
    expect(text).toContain('secretPolicy: Require secure storage (require_secure)');
  });

  test('autoApprove=true with mode=prompt (the reproduced disagreement bug): status honestly says auto-approve is on', () => {
    const text = renderCliStatus(makeOptions({
      'permissions.mode': 'prompt',
      'behavior.autoApprove': true,
    }));

    // The historical bug: this surface derived its label from
    // permissions.mode alone and would have printed "Ask before powerful
    // actions" here, disagreeing with the gate (which checks autoApprove
    // first and bypasses everything). It must now say auto-approve is on.
    expect(text).toContain('Auto-approve ON');
    expect(text).toContain('autoApprove: yes (behavior.autoApprove)');
    expect(text).not.toContain('permissions: Ask before powerful actions');
  });

  test('doctor flags auto-approve as a distinct risk finding, independent of permissions.mode', () => {
    const text = renderCliStatus({
      ...makeOptions({
        'permissions.mode': 'prompt',
        'behavior.autoApprove': true,
      }),
      doctor: true,
    });

    expect(text).toContain('[risk:security:auto-approve-enabled]');
    expect(text).toContain('cause: behavior.autoApprove is true.');
    expect(text).not.toContain('[risk:security:allow-all-permissions]');
  });

  test('default posture (autoApprove=false, mode=prompt) still reads "prompt" everywhere', () => {
    const text = renderCliStatus(makeOptions({ 'permissions.mode': 'prompt' }));

    expect(text).toContain('permissions: Ask before powerful actions (prompt)');
    expect(text).toContain('autoApprove: no (behavior.autoApprove)');
    expect(text).not.toContain('Auto-approve ON');
  });

  test('doctor findings include cause, impact, and action', () => {
    const text = renderCliStatus({
      ...makeOptions({
        'permissions.mode': 'allow-all',
        'danger.httpListener': true,
        'httpListener.hostMode': 'network',
        'httpListener.host': '0.0.0.0',
      }),
      doctor: true,
    });

    expect(text).toContain('[risk:security:allow-all-permissions]');
    expect(text).toContain('cause: permissions.mode is allow-all.');
    expect(text).toContain('impact: Powerful write, edit, network, and execution tools can run without a Human-in-the-Loop (HITL) approval prompt.');
    expect(text).toContain('action: Use Ask before powerful actions or Custom rules unless this is an intentionally trusted environment.');
    expect(text).not.toContain('network-http-listener-enabled');
  });

  test('connected-host posture findings never instruct Agent to mutate services', () => {
    const findings = buildCliDoctorFindings({
      ...makeOptions(),
      service: makeServicePosture({
        issues: ['Connected-host settings are present, but Agent host ownership is disabled by design.'],
      }),
    });
    const text = findings.map((finding) => `${finding.summary}\n${finding.action}`).join('\n');

    expect(text).toContain('Connected-host settings are present, but Agent host ownership is disabled by design.');
    expect(text).toContain('repair the connected GoodVibes host outside Agent');
    expect(text).not.toContain('Enable service mode');
    expect(text).not.toContain('Enable service.autostart');
    expect(text).not.toContain('Enable service.restartOnFailure');
  });

  test('status foregrounds live connected host and Agent Knowledge readiness', () => {
    const text = renderCliStatus(makeOptions());

    expect(text).toContain('Connected GoodVibes host:');
    expect(text).toContain('baseUrl: http://127.0.0.1:3421');
    expect(text).toContain('reachable: yes (HTTP 200)');
    expect(text).toContain('Agent Knowledge: ready');
    expect(text).toContain('Agent role:');
    expect(text).toContain('product: interactive operator TUI');
    expect(text).toContain('host lifecycle: external');
    expect(text).toContain('starts or exposes host: no');
    expect(text).not.toContain('installed:');
    expect(text).not.toContain('running:');
    expect(text).not.toContain('platform:');
    expect(text).not.toContain('Runtime Endpoint Diagnostics:');
    expect(text).not.toContain('Endpoint Diagnostics:');
    expect(text).not.toContain('runtimeApi:');
    expect(text).not.toContain('hostConfigEnabled');
    expect(text).not.toContain('hostAutostart');
    expect(text).not.toContain('hostRestartOnFailure');
  });

  test('doctor keeps endpoint diagnostics out of Agent status and lists readiness checks', () => {
    const text = renderCliStatus({ ...makeOptions(), doctor: true });

    expect(text).toContain('Connected GoodVibes host:');
    expect(text).toContain('Readiness Checks:');
    expect(text).toContain('companion chat route');
    expect(text).toContain('isolated Agent Knowledge route');
    expect(text).toContain('approvals and automation status routes');
    expect(text).toContain('explicit build delegation route');
    expect(text).not.toContain('Connected Host Config Signals:');
    expect(text).not.toContain('host config present:');
    expect(text).not.toContain('host autostart:');
    expect(text).not.toContain('host restart policy:');
    expect(text).not.toContain('Endpoint Diagnostics:');
    expect(text).not.toContain('runtimeApi: yes');
    expect(text).not.toContain('incomingWebhook: no');
  });

  test('setup status is Agent-branded', () => {
    const text = renderOnboardingCliStatus(makeOptions());

    expect(text).toContain('GoodVibes Agent setup status');
    expect(text).not.toContain('GoodVibes onboarding status');
  });

  test('doctor warns when connected host or Agent Knowledge are unavailable without suggesting fallback knowledge use', () => {
    const findings = buildCliDoctorFindings({
      ...makeOptions(),
      externalRuntime: makeExternalRuntime({
        reachable: true,
        compatible: true,
        agentKnowledge: {
          route: '/api/goodvibes-agent/knowledge/status',
          ready: false,
          kind: 'connected_host_route_unavailable',
          statusCode: 404,
        },
        error: 'HTTP 404',
      }),
    });
    const text = findings.map((finding) => `${finding.summary}\n${finding.impact}\n${finding.action}`).join('\n');

    expect(findings.map((finding) => finding.id)).toContain('agent-knowledge-route-not-ready');
    expect(findings.map((finding) => finding.cause).join('\n')).toContain('/api/goodvibes-agent/knowledge/status returned connected_host_route_unavailable (404).');
    expect(findings.map((finding) => finding.cause).join('\n')).not.toContain('/api/goodvibes-agent/knowledge/status returned route_unavailable (404).');
    expect(text).toContain('Agent Knowledge ask/search will not use default or non-Agent knowledge fallback');
    expect(text).not.toContain('default knowledge');
  });

  test('network endpoint config does not report Agent-owned network auth posture', () => {
    const findings = buildCliDoctorFindings({
      ...makeOptions({
        'web.enabled': true,
        'web.hostMode': 'network',
        'web.host': '0.0.0.0',
      }),
      auth: {
        userStorePath: '/home/test/.goodvibes/agent/auth-users.json',
        userStorePresent: false,
        bootstrapCredentialPath: '/home/test/.goodvibes/agent/auth-bootstrap.txt',
        bootstrapCredentialPresent: true,
        operatorTokenPath: '/home/test/.goodvibes/daemon/operator-tokens.json',
        operatorTokenPresent: false,
      },
    });

    expect(findings.map((finding) => finding.id)).not.toContain('network-endpoint-without-runtime-auth-signal');
    expect(findings.map((finding) => finding.id)).not.toContain('network-endpoint-with-bootstrap-credential');
  });

  test('status honestly reports "checkpoints off: workspace not registered" for an unregistered workspace', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      checkpoints: { workspaceRegistered: false, unregisteredWorkspaceMode: 'off' },
    });

    expect(text).toContain('checkpoints off: workspace not registered');
    expect(text).toContain('next goodvibes-agent workspaces register --yes');
  });

  test('status reports checkpoints on for a registered workspace', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      checkpoints: { workspaceRegistered: true, unregisteredWorkspaceMode: 'off' },
    });

    expect(text).toContain('checkpoints on: workspace registered');
    expect(text).not.toContain('checkpoints off');
  });

  test('status reports the guarded override honestly for an unregistered workspace', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      checkpoints: { workspaceRegistered: false, unregisteredWorkspaceMode: 'guarded' },
    });

    expect(text).toContain('checkpoints on: unregistered workspace allowed via checkpoints.unregisteredWorkspaces="guarded"');
  });

  test('checkpoint posture never renders silently when the caller supplies nothing', () => {
    const text = renderCliStatus(makeOptions());
    expect(text).toContain('checkpoint posture unknown');
  });

  test('status JSON contract includes the checkpoints block', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      outputFormat: 'json',
      checkpoints: { workspaceRegistered: false, unregisteredWorkspaceMode: 'off' },
    });
    const parsed = JSON.parse(text) as { checkpoints: { statusLine: string; automaticCheckpointsActive: boolean } };
    expect(parsed.checkpoints.statusLine).toBe('checkpoints off: workspace not registered');
    expect(parsed.checkpoints.automaticCheckpointsActive).toBe(false);
  });

  test('status can render a stable JSON contract with connected-host details', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      outputFormat: 'json',
      service: makeServicePosture(),
    });

    const parsed = JSON.parse(text) as {
      title: string;
      provider: { provider: string };
      externalRuntime: { reachable: boolean; agentKnowledge: { ready: boolean } };
      runtimeConnection: { lifecycle: { managed: { running: boolean; commandPreview: string } } };
      runtimeEndpoints: { controlPlane: { port: number } };
      findings: unknown[];
    };

    expect(parsed.title).toBe('GoodVibes Agent status');
    expect(parsed.provider.provider).toBe('openai');
    expect(parsed.externalRuntime.reachable).toBe(true);
    expect(parsed.externalRuntime.agentKnowledge.ready).toBe(true);
    expect(parsed.runtimeConnection.lifecycle.managed.running).toBe(false);
    expect(parsed.runtimeConnection.lifecycle.managed.commandPreview).toBe('managed outside goodvibes-agent');
    expect(parsed.runtimeEndpoints.controlPlane.port).toBe(3421);
    expect(parsed.findings).toBeArray();
  });
});
