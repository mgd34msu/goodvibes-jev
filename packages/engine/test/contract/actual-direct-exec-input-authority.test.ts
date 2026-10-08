/** First-tool exec reaches the real temporary-Git contract graph and registry. */
import { expect, spyOn, test } from 'bun:test';
import * as asyncFs from 'node:fs/promises';
import { join } from 'node:path';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import { DIRECT_EXEC_CAPTURED_VALUE, DIRECT_EXEC_PRIVATE_MARKER, runDirectExecContract } from '../fixtures/captured-direct-exec-compiled-entry.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required direct registered exec containment backend is unavailable');

test.skipIf(!availability.available)('actual first-tool Bun exec builds, tests and reads generated captured members without approval', async () => {
  const opened: string[] = [];
  const read = asyncFs.readFile;
  const tap = spyOn(asyncFs, 'readFile').mockImplementation(((...args: Parameters<typeof read>) => {
    opened.push(String(args[0]));
    return read(...args);
  }) as typeof read);
  const open = asyncFs.open;
  const openTap = spyOn(asyncFs, 'open').mockImplementation(((...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  }) as typeof open);
  try {
    const proof = await runDirectExecContract(() => { opened.length = 0; });
    expect(proof.status, JSON.stringify(proof)).toBe('passed');
    expect(proof.storedDenial).toBe(true);
    expect(proof.originalReadAccess).toBe('restricted');
    expect(proof.approvalCalls).toBe(0);
    expect(proof.plannerCalls).toBe(1);
    expect(proof.memberCalls).toBe(3);
    // No preceding write validator, REPL, or manual admission can warm Bun up.
    expect(proof.executed).toEqual([{ name: 'exec', success: true }, { name: 'read', success: true }]);
    expect(proof.memberRoot).not.toBe(proof.ownerRoot);
    expect(proof.ownerGeneratedDuringExec).toBe(false);
    expect(proof.ownerValue).toContain('LATE_OWNER_DIRECT_EXEC_VALUE');
    expect(opened).toContain(join(proof.memberRoot!, 'allowed.ts'));
    expect(opened).toContain(join(proof.memberRoot!, 'bunfig.toml'));
    expect(opened).toContain(join(proof.memberRoot!, 'first-preload.ts'));
    expect(opened.some((path) => path.endsWith('/private.ts'))).toBe(false);
    expect(JSON.parse(proof.generated!)).toEqual({
      value: DIRECT_EXEC_CAPTURED_VALUE, configuredType: 'PROJECT_LOADER_OK', configValue: 'PROJECT_CONFIG_OK',
      startupOrder: ['first', 'second'], denied: ['DENIED_READ', 'DENIED_READ', 'DENIED_IMPORT'],
      mode: null, ambient: null, credential: null, ownerVisible: false, hostVisible: false, networkBlocked: true,
    });
    expect(proof.generatedSource).toContain(DIRECT_EXEC_CAPTURED_VALUE);
    const messages = proof.requests.filter((request) => !request.planner).flatMap((request) => request.messages);
    const exec = messages.find((message) => message.role === 'tool' && message.name === 'exec' && message.callId === 'direct-exec-step-1');
    expect(JSON.parse(String(exec?.content))).toMatchObject({ success: true, sandboxed: true, exit_code: 0, stdout: expect.stringContaining('DIRECT_EXEC_BUILD_TEST_OK') });
    const readback = messages.find((message) => message.role === 'tool' && message.name === 'read' && message.callId === 'direct-exec-step-2');
    expect(String(readback?.content)).toContain(DIRECT_EXEC_CAPTURED_VALUE);
    expect(String(readback?.content)).toContain('PROJECT_CONFIG_OK');
    expect(String(readback?.content)).toContain('PROJECT_LOADER_OK');
    for (const request of proof.requests) {
      expect(request.text).not.toContain(DIRECT_EXEC_PRIVATE_MARKER);
      expect(request.text).not.toContain('LATE_OWNER_DIRECT_EXEC_VALUE');
    }
  } finally { tap.mockRestore(); openTap.mockRestore(); }
}, 90_000);
