import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  buildCliServicePosture,
  formatCliServicePosture,
} from '../../cli/service-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('CLI service posture', () => {
  let root = '';

  beforeEach(() => {
    root = makeProjectTempDir('goodvibes-agent-service-posture');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createConfig(): ConfigManager {
    return new ConfigManager({
      surfaceRoot: 'agent',
      workingDir: join(root, 'project'),
      homeDir: join(root, 'home'),
    });
  }

  test('reports connected-host diagnostics without resolving runtime binaries', async () => {
    const config = createConfig();
    config.setDynamic('service.enabled', true);
    config.setDynamic('service.autostart', true);
    config.setDynamic('service.restartOnFailure', true);
    config.setDynamic('controlPlane.enabled', true);

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: join(root, 'project'),
      homeDirectory: join(root, 'home'),
    });
    const text = formatCliServicePosture(posture);

    expect(posture.managed.path).toBe('connected GoodVibes host');
    expect(posture.managed.commandPreview).toBe('managed outside goodvibes-agent');
    expect(posture.managed.suggestedCommands).toEqual([]);
    expect(posture.issues).toEqual([]);
    expect(posture.issues).not.toContain('Connected-host config is enabled, but no platform service definition is installed.');
    expect(text).toContain('GoodVibes Agent connected-host diagnostics');
    expect(text).toContain('lifecycle owner: outside goodvibes-agent');
    expect(text).toContain('Agent starts connected host: only at boot, when it is installed but stopped');
    expect(text).toContain('external host lifecycle config: only the service name is read, for the boot start check');
    // Two lines, not one. "daemon considered enabled" answered two questions
    // with one word, which is precisely how a machine with adoption off and a
    // live connected host read as having no daemon at all.
    expect(text).toContain('adopts a daemon of its own: yes');
    expect(text).toContain('may dial the connected host: yes');
    expect(text).not.toContain('installed:');
    expect(text).not.toContain('running:');
    expect(text).not.toContain('platform:');
    expect(text).not.toContain('external host autostart config');
    expect(text).not.toContain('external host restart config');
    expect(text).not.toContain(`goodvibes-${'daemon'}`);
    expect(text).not.toContain('systemctl');
    expect(text).not.toContain('runtime lifecycle flag');
  });

  test('probe mode reports enabled endpoint reachability without lifecycle mutations', async () => {
    const config = createConfig();
    config.setDynamic('service.enabled', true);
    config.setDynamic('service.autostart', true);
    config.setDynamic('service.restartOnFailure', true);
    config.setDynamic('controlPlane.enabled', true);
    config.setDynamic('controlPlane.port', 1);

    const posture = await buildCliServicePosture(
      {
        configManager: config,
        workingDirectory: join(root, 'project'),
        homeDirectory: join(root, 'home'),
      },
      { probe: true },
    );

    expect(posture.endpoints.find((endpoint) => endpoint.id === 'controlPlane')?.reachable).toBe(false);
    expect(posture.issues).toContain('runtime connection is enabled but not reachable on 127.0.0.1:1.');
    expect(posture.managed.commandPreview).toBe('managed outside goodvibes-agent');
  });

  test('reads configured service logs with redaction', async () => {
    const config = createConfig();
    const logPath = join(root, 'daemon.log');
    writeFileSync(logPath, 'token=secret-value GOODVIBES_DAEMON_TOKEN=abc123\n', 'utf-8');
    config.setDynamic('service.logPath', logPath);

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: join(root, 'project'),
      homeDirectory: join(root, 'home'),
    });

    expect(posture.log.exists).toBe(true);
    expect(posture.log.tail).not.toContain('abc123');
    expect(posture.log.tail).toContain('<redacted>');
  });

  test('json output preserves endpoint and connected-host ownership structure', async () => {
    const config = createConfig();
    config.setDynamic('daemon.enabled', true);
    config.setDynamic('service.enabled', false);

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: join(root, 'project'),
      homeDirectory: join(root, 'home'),
    });
    const parsed = JSON.parse(formatCliServicePosture(posture, true)) as {
      managed: { commandPreview: string; path: string };
      endpoints: Array<{ id: string }>;
      issues: string[];
      advisories: string[];
    };

    expect(parsed.managed.path).toBe('connected GoodVibes host');
    expect(parsed.managed.commandPreview).toBe('managed outside goodvibes-agent');
    expect(parsed.endpoints.map((endpoint) => endpoint.id)).toContain('controlPlane');
    // Reported as an ADVISORY, not an issue: the Agent is designed not to own
    // the host, so this describes the intended arrangement rather than a fault.
    expect(parsed.advisories).toContain('Connected-host settings are present, but Agent host ownership is disabled by design.');
    expect(parsed.issues).not.toContain('Connected-host settings are present, but Agent host ownership is disabled by design.');
  });
});
