/**
 * A fake judgment port for one test file's own decisions.
 *
 * The installed port is process-wide: a reading another test file started in
 * the background (a booted daemon, runtime services starting up) can land on
 * whatever port is installed when it fires. A test that counts requests would
 * then count someone else's. This port records and answers only requests
 * whose decision context names one of `batteries`, and rejects any other
 * request with an error naming its battery, so a stray reading cannot change
 * what the test sees.
 */
import type { JudgmentPort, JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { fakePort, type Answerer } from '@goodvibes-jev/judgment/testing';

export function decisionPort(batteries: readonly string[], answer: Answerer): { port: JudgmentPort; requests: JudgmentRequest<Questions>[] } {
  const own = fakePort(answer);
  const port: JudgmentPort = {
    model: own.port.model,
    async ask(request) {
      const battery = request.context?.battery;
      if (battery === undefined || !batteries.includes(battery)) {
        throw new Error(`decisionPort: a request from ${battery ?? 'an unnamed decision'} reached a port for ${batteries.join(', ')}`);
      }
      return own.port.ask(request);
    },
  };
  return { port, requests: own.requests };
}
