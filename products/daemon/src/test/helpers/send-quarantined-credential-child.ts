/** Isolated source-command fixture: the child owns its synthetic environment. */
import { spyOn } from 'bun:test';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { runDaemonCli } from '../../cli/run.js';
import { SecretsManager } from '../../config/secrets.js';
import * as composition from '../../daemon/send/composition.js';

if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Guarded send fixture required');
let secretLookups = 0; let serviceLookups = 0; let fetches = 0; let stacks = 0;
const originalStack = composition.createSendStack;
spyOn(composition, 'createSendStack').mockImplementation((configuration) => { stacks += 1; return originalStack(configuration); });
spyOn(SecretsManager.prototype, 'get').mockImplementation(async () => { secretLookups += 1; return null; });
spyOn(ServiceRegistry.prototype, 'resolveSecret').mockImplementation(async () => { serviceLookups += 1; return null; });
spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { fetches += 1; return new Response(null); }, {
  preconnect() { throw new Error('Unexpected fixture preconnect'); },
}));
const stdout: string[] = []; const stderr: string[] = [];
const exitCode = await runDaemonCli(['send', '--channel', 'ntfy', '--to', 'synthetic-topic', 'synthetic body'], {
  stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
});
console.log(JSON.stringify({ exitCode, stdout, stderr, secretLookups, serviceLookups, fetches, stacks,
  hasSyntheticEnvironmentToken: process.env.NTFY_ACCESS_TOKEN === 'synthetic-environment-token' }));
