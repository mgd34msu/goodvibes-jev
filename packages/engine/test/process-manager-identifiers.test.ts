import { expect, spyOn, test } from 'bun:test';
import { ProcessManager, type BgCommandResult } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

const epoch = 1_700_000_000_004;
const encodedEpoch = 'bhaaaaaaaaaae';

test('same-time ordinary allocations preserve the counter injectively across decimal digit boundaries', async () => {
  const manager = new ProcessManager();
  const clock = spyOn(Date, 'now').mockReturnValue(epoch);
  try {
    const ids: string[] = [];
    for (let count = 1; count <= 12; count++) {
      const result = await manager.spawn('printf identifier', undefined, undefined);
      ids.push(result.process_id!);
    }
    expect(new Set(ids).size).toBe(12);
    expect(ids[0]).toBe(`bg_b_${encodedEpoch}`);
    expect(ids[8]).toBe(`bg_j_${encodedEpoch}`);
    expect(ids[9]).toBe(`bg_ba_${encodedEpoch}`);
    expect(ids[11]).toBe(`bg_bc_${encodedEpoch}`);
    for (const id of ids) {
      expect(id).toMatch(/^bg_[a-j]+_[a-j]+$/);
      expect(manager.getStatus(id)?.id).toBe(id);
      expect(manager.handleCommand(`bg_status ${id}`)?.success).toBe(true);
    }
  } finally { clock.mockRestore(); await manager.close(); }
});

test('owned allocation retains its previous spelling and exact owner-bound identity', async () => {
  const manager = new ProcessManager();
  const owner = {};
  const otherOwner = {};
  let finish!: (result: BgCommandResult) => void;
  const completion = new Promise<BgCommandResult>((resolve) => { finish = resolve; });
  const output: BgCommandResult = { cmd: 'fixture', exit_code: null, stdout: 'owned output', stderr: '', success: true };
  let reads = 0;
  let stops = 0;
  const clock = spyOn(Date, 'now').mockReturnValue(epoch);
  try {
    const started = await manager.trackOwnedBoundary({ owner, cmd: 'fixture', started: Promise.resolve({ pid: 1234 }), completion,
      readOutput: async () => { reads++; return output; },
      stop: async () => { stops++; finish({ ...output, exit_code: 0 }); },
    });
    expect(started.process_id).toBe(`bg_owned_b_${encodedEpoch}`);
    const id = started.process_id!;
    expect(manager.hasBoundaryOwner(id)).toBe(true);
    const readsBefore = reads;
    for (const command of ['status', 'output', 'stop']) {
      expect(await manager.handleOwnedBoundaryCommand(`bg_${command} ${id}`, otherOwner)).toMatchObject({
        success: false, stdout: '', stderr: 'Unknown process in this execution authority',
      });
    }
    expect(reads).toBe(readsBefore);
    expect(stops).toBe(0);
    expect(await manager.handleOwnedBoundaryCommand(`bg_output ${id}`, owner)).toMatchObject({ success: true, stdout: 'owned output' });
    expect(await manager.handleOwnedBoundaryCommand(`bg_status ${id}`, owner)).toMatchObject({ success: true });
    expect(await manager.handleOwnedBoundaryCommand(`bg_stop ${id}`, owner)).toMatchObject({ success: true });
    expect(stops).toBe(1);
    expect(manager.getStatus(id)).toBeUndefined();
  } finally { clock.mockRestore(); finish({ ...output, exit_code: 0 }); await manager.close(); }
});
