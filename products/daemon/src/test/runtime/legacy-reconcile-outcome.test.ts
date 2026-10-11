import { expect, test } from 'bun:test';
import { INSTALLER_UNIT_MARKER, reconcileRedundantLegacyUnit } from '../../runtime/legacy-daemon-reconcile.js';

function fixture(disableTimedOut: boolean) {
  const removed: string[] = [];
  const calls: string[] = [];
  const input = {
    homeDir: '/fixture', trackedServiceName: 'goodvibes', ownPid: 9999,
    legacyUnitFileExists: () => true,
    legacyUnitFileRead: () => `# ${INSTALLER_UNIT_MARKER}`,
    legacyUnitFileRemove(path: string) { removed.push(path); },
    processAlive: (pid: number) => pid === 4242,
    readOwnCgroup: () => '',
    configuredEndpoint: { host: '127.0.0.1', port: 3421 }, endpointProbe: () => true,
    actionRunner(_command: string, args: readonly string[]) {
      const action = args[1]!; calls.push(action);
      if (action === 'is-active') return { status: 0, stdout: 'active' };
      if (action === 'show') return { status: 0, stdout: args.at(-1) === 'goodvibes.service' ? '4242' : '0' };
      if (action === 'disable') return { status: disableTimedOut ? null : 0 };
      if (action === 'is-enabled') return { status: 1, stdout: 'disabled' };
      return { status: 0 };
    },
  };
  return { input, removed, calls };
}

for (const timedOut of [false, true]) {
  test.each([new Error('EACCES fixture'), undefined])(`removal failure is structured failure after disable timedOut=${timedOut}`, async (error) => {
    const f = fixture(timedOut);
    const result = await reconcileRedundantLegacyUnit({ ...f.input, legacyUnitFileRemove() { throw error; } });
    expect(result.action).toBe('failed');
    expect(result.reason).toBe('remove-failed');
    expect(result.lines.join('\n')).toContain(timedOut ? 'no longer enabled' : 'was disabled');
    expect(result.lines.join('\n')).toContain('could not be confirmed');
    expect(result.lines.join('\n')).not.toContain('was disabled and removed');
    expect(result.lines.join('\n')).not.toContain('unit file was removed');
  });

  test.each([1, null, 'throws'] as const)(`reload failure %s retains the completed removal receipt after timedOut=${timedOut}`, async (status) => {
    const f = fixture(timedOut);
    const result = await reconcileRedundantLegacyUnit({ ...f.input,
      actionRunner(command, args) {
        if (args[1] === 'daemon-reload') {
          f.calls.push('daemon-reload');
          if (status === 'throws') throw undefined;
          return { status };
        }
        return f.input.actionRunner(command, args);
      },
    });
    expect(result.action).toBe('failed');
    expect(result.reason).toBe('reload-failed');
    expect(f.removed).toEqual(['/fixture/.config/systemd/user/goodvibes-daemon.service']);
    expect(result.lines.join('\n')).toContain(timedOut ? 'unit file was removed' : 'was disabled and removed');
    expect(result.lines.join('\n')).toContain('daemon-reload did not report success');
  });
}

test('startup cancellation during endpoint probe fences all retirement writes', async () => {
  const f = fixture(false); const abort = new AbortController();
  let release!: (value: boolean) => void;
  const result = reconcileRedundantLegacyUnit({ ...f.input, signal: abort.signal,
    endpointProbe: () => new Promise<boolean>((resolve) => { release = resolve; }),
  });
  abort.abort(); release(true);
  expect(await result).toEqual({ action: 'noop', reason: 'aborted', lines: [] });
  expect(f.calls).not.toContain('disable'); expect(f.removed).toEqual([]);
});

test('pre-aborted startup does not inspect the filesystem or service', async () => {
  const f = fixture(false); const abort = new AbortController(); abort.abort();
  const result = await reconcileRedundantLegacyUnit({ ...f.input, signal: abort.signal,
    legacyUnitFileExists: () => { throw new Error('must not inspect'); },
  });
  expect(result.reason).toBe('aborted'); expect(f.calls).toEqual([]);
});
