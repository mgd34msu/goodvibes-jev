/**
 * connected-host-dial-gate.test.ts
 *
 * `daemon.enabled` used to gate every call through the verb caller. On the
 * owner's machine it is false, and the effect was that the session-inputs poll
 * (refused every two seconds, thousands of log lines an hour), the
 * conversation-rewind host registration, the approvals update stream and the
 * hosted-conversation handoff all refused, while the session spine, the memory
 * spine and the operator tools dialed the SAME live host without trouble.
 *
 * The two meanings are now two settings. These tests pin the one that matters:
 * a machine configured like the owner's dials everything.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAgentDaemonVerbCaller, resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '../../runtime/connected-host-auth.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * A home directory carrying a connected-host operator token, so token presence
 * is never what a test is accidentally measuring.
 */
function homeWithOperatorToken(): { home: string; cleanup: () => void } {
  const home = makeProjectTempDir('gv-dial-gate');
  const path = connectedHostOperatorTokenPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token: 'operator-token-value' }));
  // Fail loudly rather than let a fixture drift turn every assertion below into
  // a vacuous pass: these tests are only meaningful when a token IS present, so
  // that token presence is never what they are accidentally measuring.
  const check = readConnectedHostOperatorToken(home);
  if (check.token !== 'operator-token-value') {
    throw new Error(`the operator-token fixture did not take at ${path}`);
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A config manager answering a fixed key→value map, like the real one. */
function configWith(values: Record<string, unknown>): never {
  return { get: (key: string) => values[key] } as never;
}

describe('the connected-host dial gate', () => {
  test("the owner's configuration, daemon.enabled false, no longer refuses the dial", () => {
    const { home, cleanup } = homeWithOperatorToken();
    try {
      const resolved = resolveConnectedHostConnection({
        configManager: configWith({
          'daemon.enabled': false,
          'controlPlane.host': '127.0.0.1',
          'controlPlane.port': 3421,
        }),
        homeDirectory: home,
      });
      // It must RESOLVE. Before the split this returned "the connected host is
      // disabled (daemon.enabled=false), nothing to reach", and every seam
      // built on this caller went dark on a machine whose host was answering.
      if ('reason' in resolved) {
        throw new Error(`expected a resolved connected host, got a refusal: ${resolved.reason}`);
      }
      expect(resolved.baseUrl).toBe('http://127.0.0.1:3421');
      expect(resolved.token).toBe('operator-token-value');
    } finally {
      cleanup();
    }
  });

  test('an explicit refusal to dial is honored, and names the setting that caused it', () => {
    const { home, cleanup } = homeWithOperatorToken();
    try {
      const resolved = resolveConnectedHostConnection({
        configManager: configWith({
          'daemon.connectedHost.enabled': false,
          'controlPlane.host': '127.0.0.1',
          'controlPlane.port': 3421,
        }),
        homeDirectory: home,
      });
      expect('reason' in resolved).toBe(true);
      if (!('reason' in resolved)) throw new Error('unreachable');
      // The refusal must name the key a person can change.
      expect(resolved.reason).toContain('daemon.connectedHost.enabled');
    } finally {
      cleanup();
    }
  });

  test('the verb caller probes available on a config like the owner\'s', () => {
    const { home, cleanup } = homeWithOperatorToken();
    try {
      const verbs = createAgentDaemonVerbCaller({
        configManager: configWith({
          'daemon.enabled': false,
          'controlPlane.host': '127.0.0.1',
          'controlPlane.port': 3421,
        }),
        homeDirectory: home,
      });
      // This probe is what the inputs poll, the rewind registration and the
      // approvals stream all consult before they do anything. On the owner's
      // machine it answered "not available" every two seconds.
      expect(verbs.probe()).toEqual({ available: true });
    } finally {
      cleanup();
    }
  });

  test('turning the dial off stops the verb caller, which is the whole point of having the setting', () => {
    const { home, cleanup } = homeWithOperatorToken();
    try {
      const verbs = createAgentDaemonVerbCaller({
        configManager: configWith({
          'daemon.connectedHost.enabled': false,
          'controlPlane.host': '127.0.0.1',
          'controlPlane.port': 3421,
        }),
        homeDirectory: home,
      });
      const probe = verbs.probe();
      expect(probe.available).toBe(false);
      if (probe.available) throw new Error('unreachable');
      expect(probe.reason).toContain('daemon.connectedHost.enabled');
    } finally {
      cleanup();
    }
  });

  test('a config manager that cannot answer is a refusal, never a thrown probe', () => {
    const verbs = createAgentDaemonVerbCaller({
      configManager: {} as never,
      homeDirectory: '/nonexistent',
    });
    const probe = verbs.probe();
    expect(probe.available).toBe(false);
    if (probe.available) throw new Error('unreachable');
    expect(probe.reason).toContain('no config manager');
  });
});
