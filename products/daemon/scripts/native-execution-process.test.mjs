import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from './native-execution-process.mjs';

test('owned timeout signals the descendant group that holds inherited output', async () => {
  // Real inert Node children; no compiler, provider, model or daemon service.
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    child.once('spawn',()=>process.stdout.write('ready\\n')); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
  try {
    const ready = new Promise((yes, no) => { child.stdout.once('data', chunk => chunk.toString() === 'ready\n' ? yes() : no(new Error('Unexpected fixture readiness'))); });
    await boundedNativeProcessClose(ready, 2_000, 'Inert process fixture startup deadline');
    signalNativeProcessGroup(child);
    assert.deepEqual(await boundedNativeProcessClose(stopped, 2_000, 'Inherited output close deadline'), { code: null, signal: 'SIGKILL' });
    await drainNativeProcessGroup(child, stopped); assertNativeProcessGroupDrained(child);
  } finally {
    try { await drainNativeProcessGroup(child, stopped); } finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
});

test('a close promise that never resolves refuses within its explicit budget', async () => {
  await assert.rejects(boundedNativeProcessClose(new Promise(() => {}), 10, 'bounded-close-fixture'), /bounded-close-fixture/);
});
