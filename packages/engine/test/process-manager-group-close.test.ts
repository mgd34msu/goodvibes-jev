import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { waitFor } from './_helpers/test-timeout.js';
useToolReadings([['', { credential: true }]]);
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

if (process.platform !== 'win32') {
  for (const [exitEarly, external, stopFirst] of [[false, false, false], [false, false, true], [true, false, false], [true, true, false]] as const) {
    test(`POSIX close drains owned shell descendants: leader exited=${exitEarly}, external=${external}, explicit stop=${stopFirst}`, async () => {
      const directory = makeProjectTempDir('process-group-close');
      const pidFile = join(directory, 'pid'); const marker = join(directory, 'marker');
      const manager = new ProcessManager();
      // A bounded, fixture-owned descendant deliberately ignores SIGTERM and
      // inherits the shell pipes. A surviving child proves itself by writing.
      const code = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setTimeout(() => {require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived');}, 1800);`;
      let observationFinished = false;
      try {
        const child = await manager.spawn(`${quote(process.execPath)} --no-env-file -e ${quote(code)} & ${exitEarly ? `while [ ! -f ${quote(pidFile)} ]; do /bin/sleep 0.01; done; exit 0` : 'wait'}`,
          directory, undefined, { timeout_ms: 12_000, sigterm_grace_ms: 20, kill_on_timeout: !external });
        await waitFor(() => existsSync(pidFile));
        if (exitEarly) await waitFor(() => manager.getStatus(child.process_id!)?.done === true);
        const status = manager.getStatus(child.process_id!)!;
        if (stopFirst) expect(manager.stop(child.process_id!)).toBe(true);
        const started = Date.now(); await manager.close();
        expect(Date.now() - started).toBeLessThan(1500);
        expect(status.done).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        observationFinished = true;
        expect(existsSync(marker)).toBe(external);
      } finally {
        await manager.close();
        // Never signal a stale descendant PID after the bounded fixture exits.
        // On an early failure, allow its 1.8-second timer to finish naturally.
        if (!observationFinished) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }, 10_000);
  }
} else {
  console.warn('[coverage] POSIX owned process-group shutdown is unavailable on Windows; only direct child handles are owned there.');
}
