/**
 * A standalone child process that installs the agent's process-fault capture
 * and then raises a REAL uncaught exception.
 *
 * Spawned by src/test/runtime/process-fault-capture.test.ts. It has to be a
 * separate process because the behaviour under test is what survives an actual
 * process-level fault, an in-process test would only ever exercise a function
 * call, which is precisely the thing that was already fine. What was broken was
 * the path where the process dies.
 *
 * argv[2] is the directory to treat as HOME.
 */
import { join } from 'node:path';
import { configureActivityLogger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createProcessFaultHandlers } from '../../runtime/process-fault-capture.ts';

const home = process.argv[2];
if (!home) {
  process.stderr.write('crash-capture-probe: missing home directory argument\n');
  process.exit(2);
}

// Mirror the real entrypoint: the shared activity log is project-anchored.
configureActivityLogger(join(home, '.goodvibes', 'logs'));

const faults = createProcessFaultHandlers({
  notifyHigh: () => {},
  render: () => {},
  shellPaths: { resolveUserPath: (...segments: string[]) => join(home, '.goodvibes', ...segments) },
  activeSessionId: () => 'user-cd11b528',
});
faults.register();

// Raise the fault from a timer so it reaches the process-level handler the way
// a real one does, rather than unwinding through this module's own frame.
setTimeout(() => {
  throw new Error('injected fatal from crash-capture-probe');
}, 0);
