/**
 * Coverage-gap smoke test, platform/discovery
 * Verifies that the scanner and mcp-scanner modules load, export their
 * primary symbols, and execute observable behavior via await.
 * Closes coverage gap: platform/discovery
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedTestChild } from '../scripts/owned-test-child.ts';
import {
  scanHosts,
  scanLocalhost,
  loadPersistedProviders,
} from '../sdk/src/platform/discovery/scanner.js';
import {
  scanMcpServers,
} from '../sdk/src/platform/discovery/mcp-scanner.js';

describe('platform/discovery: behavior smoke', () => {
  test('loadPersistedProviders returns empty array for non-existent persist path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-test-'));
    try {
      const result = loadPersistedProviders({
        homeDirectory: tmp,
        surfaceRoot: 'gv-test-surface',
      });
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scan() completes every probe against fixture transport before returning its result', async () => {
    // Bun's built-in named imports do not follow spyOn on the default os
    // object. Keep this module replacement in an owned child so it cannot
    // leak into other files, and import the actual scanner after installing it.
    const directory = mkdtempSync(join(tmpdir(), 'scan-fixture-'));
    const fixture = join(directory, 'scan.test.ts');
    try {
      writeFileSync(fixture, `
        import { expect, mock, test } from 'bun:test';
        const os = await import('node:os');
        mock.module('node:os', () => ({ ...os, networkInterfaces: () => ({ fixture: [{
          address: '192.0.2.10', netmask: '255.255.255.0', family: 'IPv4',
          mac: '00:00:00:00:00:00', internal: false, cidr: '192.0.2.10/24',
        }] }) }));
        const { scan } = await import(${JSON.stringify(new URL('../sdk/src/platform/discovery/scanner.ts', import.meta.url).href)});
        test('all fixture probes finish', async () => {
          let requests = 0;
          globalThis.fetch = Object.assign(async () => { requests++; return new Response('', { status: 404 }); }, { preconnect() {} });
          const result = await scan();
          expect(result.servers).toEqual([]);
          expect(result.scannedHosts).toBe(255);
          expect(typeof result.scannedPorts).toBe('number');
          expect(typeof result.durationMs).toBe('number');
          expect(requests).toBe(result.scannedHosts * result.scannedPorts);
        });
      `);
      const result = await runOwnedTestChild({ argv: [fixture], cwd: directory, env: process.env });
      expect(result.exitCode).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('scanHosts([]) resolves with empty DiscoveredServer array for empty host list', async () => {
    // Empty host list, no probes, immediate resolution
    const result = await scanHosts([]);
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(0);
  });

  test('scanLocalhost() resolves with ScanResult shape', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response('', { status: 404 }), { preconnect() {} }));
    try {
      const result = await scanLocalhost();
      expect(result.servers).toBeInstanceOf(Array);
      expect(typeof result.scannedHosts).toBe('number');
      expect(typeof result.scannedPorts).toBe('number');
      expect(typeof result.durationMs).toBe('number');
      expect(result.scannedHosts).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(result.scannedPorts);
    } finally { fetchSpy.mockRestore(); }
  });

  test('scanMcpServers() resolves with McpDiscoveryResult shape (suggestions array, locationsScanned)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-mcp-scan-test-'));
    try {
      const result = await scanMcpServers({
        workingDirectory: tmp,
        homeDirectory: tmp,
        surfaceRoot: 'gv-test',
      });
      expect(result.suggestions).toBeInstanceOf(Array);
      expect(typeof result.locationsScanned).toBe('number');
      expect(result.locationsScanned).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
