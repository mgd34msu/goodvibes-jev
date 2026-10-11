import assert from 'node:assert/strict';

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Call only for the retained ChildProcess just created with detached:true. */
export function signalNativeProcessGroup(child, signal = 'SIGKILL') {
  if (child.pid === undefined) { child.kill(signal); return; }
  assert(Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid, 'Retain the actual owned child process group');
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export function assertNativeProcessGroupDrained(child) {
  if (child.pid !== undefined) assert(!groupExists(child.pid), 'Native command left an owned process group');
}

export async function boundedNativeProcessClose(stopped, milliseconds, message) {
  let timer;
  try { return await Promise.race([stopped, new Promise((_, no) => { timer = setTimeout(() => no(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function drainNativeProcessGroup(child, stopped) {
  signalNativeProcessGroup(child);
  await boundedNativeProcessClose(stopped.catch(() => {}), 2_000, 'Owned native close did not drain');
  const started = Date.now();
  while (child.pid && groupExists(child.pid) && Date.now() - started < 2_000) await new Promise(yes => setTimeout(yes, 20));
  assertNativeProcessGroupDrained(child);
}
