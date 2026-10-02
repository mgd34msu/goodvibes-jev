/** Real Bun subprocess fixture; communication is only through pipes and signals. */
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runDaemonProcess } from '../../daemon/process-lifecycle.js';

const mode = process.argv[2];
const marker = 'PRIVATE_PROCESS_FAILURE_SENTINEL';
const events = (event: string) => { writeSync(1, `${event}\n`); };
let releaseStart!: () => void;
let releaseClose!: () => void;
const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'release-start') releaseStart();
  if (line === 'release-close') releaseClose();
});
process.on('exit', (code) => {
  events(`EXIT:${code}:${process.listenerCount('SIGINT')}:${process.listenerCount('SIGTERM')}`);
});

runDaemonProcess(() => {
  events('ACQUIRED');
  if (mode === 'factory-failure') throw new Error(marker);
  return {
    async start() {
      events('STARTING');
      if (mode === 'held-start') await startGate;
      if (mode === 'startup-failure') throw new Error(marker);
      events('READY');
    },
    async close() {
      events('CLOSING');
      if (mode === 'timeout') {
        input.close();
        process.stdin.pause();
        await new Promise<void>(() => {});
      }
      if (mode === 'held-start') await startGate;
      if (mode === 'delayed-close' || mode === 'held-start' || mode === 'startup-failure') await closeGate;
      if (mode === 'close-failure') throw new Error(marker);
      events('CLOSED');
      input.close();
      process.stdin.pause();
    },
  };
}, { shutdownTimeoutMs: mode === 'timeout' ? 150 : 5_000 });
