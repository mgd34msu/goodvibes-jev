import { describe, expect, test } from 'bun:test';
import { daemonCatalogOffersWebuiStatus, readWebBindingFromDaemon } from './daemon-binding';

const result = { schema: 'goodvibes.daemon.webui-binding', schemaVersion: 1, source: 'configuration', endpoint: 'web' };
const query = { args: ['status', '--json'], result };
const command = { name: 'webui', subcommands: ['enable', 'disable', 'status'], machineQueries: [query] };
const catalog = { schema: 'goodvibes.daemon.cli-catalog', schemaVersion: 1, commands: [command] };
const binding = { ...result, enabled: true, host: '127.0.0.1', port: 3423, url: 'http://127.0.0.1:3423' };

describe('daemon discovery uses only declared machine capabilities', () => {
  test('exact command, query and output contract permit discovery', () => {
    expect(daemonCatalogOffersWebuiStatus(JSON.stringify(catalog))).toBe(true);
    const calls: string[][] = [];
    const output = readWebBindingFromDaemon((args) => {
      calls.push([...args]);
      return JSON.stringify(calls.length === 1 ? catalog : binding);
    });
    expect(calls).toEqual([['--help', '--json'], ['webui', 'status', '--json']]);
    expect(output).toEqual({ enabled: true, host: '127.0.0.1', port: 3423, url: binding.url });
  });

  test.each([
    '', 'This daemon serves webui assets.', 'Commands:\n  webui   Not available in this build',
    'Use webui status --json with a newer binary.', 'Version 99.99.99 supports webui.',
    JSON.stringify({ webui: true }), JSON.stringify(['webui']), 'null',
    JSON.stringify({ ...catalog, schemaVersion: 2 }),
    JSON.stringify({ ...catalog, schema: 'unrelated.cli-catalog' }),
    JSON.stringify({ ...catalog, commands: [{ ...command, name: 'WebUI' }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, name: 'webui-preview' }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, subcommands: ['status-old'] }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [] }] }),
    JSON.stringify({ ...catalog, commands: [{ name: 'webui', subcommands: ['status'] }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [{ ...query, args: ['status'] }] }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [{ ...query, result: { ...result, endpoint: 'controlPlane' } }] }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [{ ...query, result: { ...result, schemaVersion: 2 } }] }] }),
    JSON.stringify({ ...catalog, commands: [command, command] }),
    JSON.stringify({ ...catalog, commands: [command, null] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [query, query] }] }),
    JSON.stringify({ ...catalog, commands: [{ ...command, machineQueries: [query,
      { ...query, result: { ...result, endpoint: 'controlPlane' } }] }] }),
  ])('unverified output never executes a status command: %s', (help) => {
    const calls: string[][] = [];
    expect(readWebBindingFromDaemon((args) => { calls.push([...args]); return help; })).toBeNull();
    expect(calls).toEqual([['--help', '--json']]);
  });

  test.each([
    '{}', 'null', '[]', 'plain status prose', JSON.stringify({ host: 'localhost', port: 3423 }),
    JSON.stringify({ ...binding, port: '3423' }), JSON.stringify({ ...binding, port: 0 }),
    JSON.stringify({ ...binding, port: 65536 }), JSON.stringify({ ...binding, port: 3.5 }),
    JSON.stringify({ ...binding, host: '' }), JSON.stringify({ ...binding, source: 'live-listener' }),
  ])('invalid status preserves fallback: %s', (status) => {
    expect(readWebBindingFromDaemon((args) => args[0] === '--help' ? JSON.stringify(catalog) : status)).toBeNull();
  });

  test('a command failure is unavailable without a retry', () => {
    let calls = 0;
    expect(readWebBindingFromDaemon(() => { calls++; throw new Error('missing, timed out, or killed'); })).toBeNull();
    expect(calls).toBe(1);
  });

  test('a failed status command does not retry or guess another command', () => {
    const calls: string[][] = [];
    expect(readWebBindingFromDaemon((args) => {
      calls.push([...args]);
      if (args[0] === '--help') return JSON.stringify(catalog);
      throw new Error('status unavailable');
    })).toBeNull();
    expect(calls).toEqual([['--help', '--json'], ['webui', 'status', '--json']]);
  });

  test('malformed optional values cannot reach Vite', () => {
    expect(readWebBindingFromDaemon((args) => JSON.stringify(args[0] === '--help' ? catalog : {
      ...binding, enabled: 'true', hostMode: {}, configuredHost: [], url: 123,
    }))).toEqual({ host: binding.host, port: binding.port });
  });

  test('cancellation before or after help suppresses every successor', () => {
    const cancelled = new AbortController(); cancelled.abort();
    expect(readWebBindingFromDaemon(() => { throw new Error('must not run'); }, cancelled.signal)).toBeNull();
    const controller = new AbortController(); const calls: string[][] = [];
    expect(readWebBindingFromDaemon((args) => {
      calls.push([...args]); controller.abort(); return JSON.stringify(catalog);
    }, controller.signal)).toBeNull();
    expect(calls).toEqual([['--help', '--json']]);
  });

  test('cancellation after status does not commit the stale binding', () => {
    const controller = new AbortController();
    expect(readWebBindingFromDaemon((args) => {
      if (args[0] === '--help') return JSON.stringify(catalog);
      controller.abort(); return JSON.stringify(binding);
    }, controller.signal)).toBeNull();
  });
});
