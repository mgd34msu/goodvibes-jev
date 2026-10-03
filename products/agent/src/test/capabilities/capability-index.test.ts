import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerCapability,
  registerFallbackCapability,
  resetCapabilityIndexForTests,
  resolveCapabilityIndex,
} from '../../capabilities/capability-index.ts';
import { emptyProbeContext, type ProbeContext } from '../../capabilities/capability-probe-runner.ts';
import type { CapabilityDeclaration } from '../../capabilities/capability-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * The incident this file exists for: the agent was asked to send an email and
 * said it could not, while working Google credentials sat in ~/.gmail-mcp. The
 * regression below is that exact shape, credentials on disk, a capability
 * registered against them, and it must resolve to ready.
 */

let home = '';

function context(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return { ...emptyProbeContext(), ...overrides };
}

function emailCapability(overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return {
    id: 'email.send',
    title: 'Send email',
    summary: 'Send a message from the owner\'s mailbox.',
    provider: 'test-google-connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google_mail',
        modelRoute: 'google_mail action:"send" to:"..." subject:"..."',
        availability: { kind: 'model-tool-registered', toolName: 'google_mail' },
      },
    ],
    prerequisites: [
      {
        id: 'google-credentials',
        label: 'Google account credentials',
        probe: {
          kind: 'any-file-present',
          paths: [join(home, '.gmail-mcp', 'credentials.json')],
          label: 'Google account credentials',
        },
        fix: 'Sign in to the Google account once so credentials are stored.',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetCapabilityIndexForTests();
  home = makeProjectTempDir('goodvibes-capability');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetCapabilityIndexForTests();
});

function writeGoogleCredentials(): string {
  const directory = join(home, '.gmail-mcp');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'credentials.json');
  writeFileSync(path, JSON.stringify({ client_id: 'test', refresh_token: 'test' }));
  return path;
}

describe('capability index: the owner\'s case', () => {
  test('credentials on disk and a registered provider resolve to ready with a route', () => {
    writeGoogleCredentials();
    registerCapability(emailCapability());

    const report = resolveCapabilityIndex(
      context({ registeredToolNames: new Set(['google_mail']) }),
      { homeDirectory: home },
    );

    const email = report.capabilities.find((entry) => entry.id === 'email.send');
    expect(email?.state).toBe('ready');
    expect(email?.modelRoute).toBe('google_mail action:"send" to:"..." subject:"..."');
    expect(email?.reason).toBeNull();
    expect(report.ready).toContain('email.send');
    // Nothing to complain about for the capability that genuinely works. The
    // same credentials still raise the neighbouring capabilities nobody has
    // wired up yet, which is the point of the check.
    expect(report.disagreements.map((entry) => entry.capabilityId)).not.toContain('email.send');
  });

  test('a genuinely missing prerequisite yields needs-setup with an actionable reason, not a denial', () => {
    // No credentials written: the provider is installed, the account is not.
    registerCapability(emailCapability());

    const report = resolveCapabilityIndex(
      context({ registeredToolNames: new Set(['google_mail']) }),
      { homeDirectory: home },
    );

    const email = report.capabilities.find((entry) => entry.id === 'email.send');
    expect(email?.state).toBe('needs-setup');
    expect(email?.reason).toContain('Google account credentials');
    expect(email?.fix).toContain('Sign in');
    expect(email?.modelRoute).toBeNull();
  });

  test('credentials present with nothing registered is reported as a defect, not as "cannot"', () => {
    // Precisely the state during the incident: the ingredients were there and
    // no provider claimed them, so every inventory honestly returned nothing.
    writeGoogleCredentials();

    const report = resolveCapabilityIndex(context(), { homeDirectory: home });

    const disagreement = report.disagreements.find((entry) => entry.capabilityId === 'email.send');
    expect(disagreement).toBeDefined();
    expect(disagreement?.evidence.join(' ')).toContain('.gmail-mcp');
    expect(disagreement?.problem).toContain('configured on this machine');
    expect(disagreement?.fix.length ?? 0).toBeGreaterThan(20);
  });

  test('no credentials and no provider produces no false alarm', () => {
    const report = resolveCapabilityIndex(context(), { homeDirectory: home });
    expect(report.disagreements).toEqual([]);
  });
});

describe('capability index states', () => {
  test('a capability with no available route is unavailable and says which routes were declared', () => {
    registerCapability(emailCapability());

    const report = resolveCapabilityIndex(context(), { homeDirectory: home });

    const email = report.capabilities.find((entry) => entry.id === 'email.send');
    expect(email?.state).toBe('unavailable');
    expect(email?.reason).toContain('google_mail action:"send"');
  });

  test('ready requires the route AND the prerequisites, never one alone', () => {
    writeGoogleCredentials();
    registerCapability(emailCapability());

    // Credentials present, tool absent.
    const withoutTool = resolveCapabilityIndex(context(), { homeDirectory: home });
    expect(withoutTool.capabilities[0]?.state).toBe('unavailable');

    // Tool present, credentials absent.
    rmSync(join(home, '.gmail-mcp'), { recursive: true, force: true });
    const withoutCredentials = resolveCapabilityIndex(
      context({ registeredToolNames: new Set(['google_mail']) }),
      { homeDirectory: home },
    );
    expect(withoutCredentials.capabilities[0]?.state).toBe('needs-setup');
  });

  test('an optional prerequisite does not block readiness', () => {
    writeGoogleCredentials();
    registerCapability(emailCapability({
      prerequisites: [
        {
          id: 'nice-to-have',
          label: 'A saved signature',
          probe: { kind: 'file-present', path: join(home, 'signature.txt'), label: 'A saved signature' },
          fix: 'Save a signature.',
          optional: true,
        },
      ],
    }));

    const report = resolveCapabilityIndex(
      context({ registeredToolNames: new Set(['google_mail']) }),
      { homeDirectory: home },
    );

    expect(report.capabilities[0]?.state).toBe('ready');
  });

  test('every not-ready capability carries both a reason and a fix', () => {
    registerCapability(emailCapability());
    const report = resolveCapabilityIndex(context(), { homeDirectory: home });
    for (const capability of report.capabilities) {
      if (capability.state === 'ready') continue;
      expect(capability.reason?.length ?? 0).toBeGreaterThan(10);
      expect(capability.fix?.length ?? 0).toBeGreaterThan(10);
    }
  });

  test('a real provider replaces a built-in placeholder regardless of order', () => {
    registerFallbackCapability({
      id: 'email.send',
      title: 'Send email',
      summary: 'placeholder',
      provider: 'built-in placeholder',
      invocations: [],
      prerequisites: [],
    });
    registerCapability(emailCapability());
    writeGoogleCredentials();

    const report = resolveCapabilityIndex(
      context({ registeredToolNames: new Set(['google_mail']) }),
      { homeDirectory: home },
    );

    expect(report.capabilities.find((entry) => entry.id === 'email.send')?.provider).toBe('test-google-connector');
    expect(report.ready).toContain('email.send');
  });

  test('a placeholder never displaces a registered provider', () => {
    registerCapability(emailCapability());
    registerFallbackCapability({
      id: 'email.send',
      title: 'Send email',
      summary: 'placeholder',
      provider: 'built-in placeholder',
      invocations: [],
      prerequisites: [],
    });

    expect(resolveCapabilityIndex(context(), { homeDirectory: home })
      .capabilities.find((entry) => entry.id === 'email.send')?.provider).toBe('test-google-connector');
  });

  test('an MCP-backed capability is ready only while its server is usable', () => {
    registerCapability({
      id: 'email.send',
      title: 'Send email',
      summary: 'Send mail through a connected MCP server.',
      provider: 'mcp',
      invocations: [
        {
          kind: 'mcp-tool-call',
          toolName: 'mcp',
          modelRoute: 'mcp mode:"call" qualifiedName:"mcp:gmail:send_email"',
          availability: { kind: 'mcp-tool-available', qualifiedName: 'mcp:gmail:send_email' },
        },
      ],
      prerequisites: [
        {
          id: 'server',
          label: 'The gmail MCP server',
          probe: { kind: 'mcp-server-connected', serverName: 'gmail' },
          fix: 'Start the gmail MCP server.',
        },
      ],
    });

    const connected = resolveCapabilityIndex(context({
      mcpToolNames: new Set(['mcp:gmail:send_email']),
      mcpServers: [{ name: 'gmail', connected: true, trustMode: 'constrained', schemaFreshness: 'fresh' }],
    }), { homeDirectory: home });
    expect(connected.capabilities[0]?.state).toBe('ready');

    const blocked = resolveCapabilityIndex(context({
      mcpToolNames: new Set(['mcp:gmail:send_email']),
      mcpServers: [{ name: 'gmail', connected: true, trustMode: 'blocked', schemaFreshness: 'fresh' }],
    }), { homeDirectory: home });
    expect(blocked.capabilities[0]?.state).toBe('needs-setup');
    expect(blocked.capabilities[0]?.reason).toContain('blocked');
  });
});
