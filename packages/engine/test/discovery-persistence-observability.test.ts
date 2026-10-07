import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadPersistedProviders,
  persistProviders,
  removePersistedProviders,
  type DiscoveredServer,
} from '../sdk/src/platform/discovery/scanner.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

const surfaceRoot = 'gv-test-surface';

function roots(tmp: string): { homeDirectory: string; surfaceRoot: string } {
  return { homeDirectory: tmp, surfaceRoot };
}

function persistedPath(tmp: string): string {
  return join(tmp, '.goodvibes', surfaceRoot, 'discovered-providers.json');
}

function sampleServer(): DiscoveredServer {
  return {
    name: 'Local Test',
    host: '127.0.0.1',
    port: 1234,
    baseURL: 'http://127.0.0.1:1234/v1',
    models: ['test-model'],
    serverType: 'unknown',
  };
}

describe('discovery persistence observability', () => {
  test('persist and remove cache-read warnings never include private text or paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const path = persistedPath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      for (const raw of ['synthetic-private-cache-value', '{"private":"synthetic-secret"}']) {
        writeFileSync(path, raw, 'utf-8');
        persistProviders(roots(tmp), [sampleServer()]);
        writeFileSync(path, raw, 'utf-8');
        removePersistedProviders(roots(tmp), [{ host: '127.0.0.1', port: 1234 }]);
      }
      expect(warnSpy.mock.calls).toEqual([
        ['[Scanner] persistProviders could not read existing discovery cache; overwriting with current scan results'],
        ['[Scanner] removePersistedProviders failed; discovery cache was not cleaned up'],
        ['[Scanner] persistProviders ignored invalid existing discovery cache; overwriting with current scan results'],
        ['[Scanner] removePersistedProviders skipped invalid discovery cache'],
      ]);
    } finally { warnSpy.mockRestore(); rmSync(tmp, { recursive: true, force: true }); }
  });

  test('loadPersistedProviders warns when the discovery cache cannot be parsed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const path = persistedPath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'synthetic-private-cache-value', 'utf-8');

      expect(loadPersistedProviders(roots(tmp))).toEqual([]);
      expect(warnSpy.mock.calls).toEqual([['[Scanner] loadPersistedProviders failed; using empty discovery cache']]);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('persistProviders warns when the discovery cache cannot be written', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(tmp, '.goodvibes'), { recursive: true });
      writeFileSync(join(tmp, '.goodvibes', surfaceRoot), 'not a directory', 'utf-8');

      expect(() => persistProviders(roots(tmp), [sampleServer()])).not.toThrow();
      expect(warnSpy.mock.calls).toEqual([['[Scanner] persistProviders failed; discovery cache was not updated']]);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('removePersistedProviders warns when the discovery cache cannot be parsed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-observe-'));
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const path = persistedPath(tmp);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'synthetic-private-cache-value', 'utf-8');

      expect(() => removePersistedProviders(roots(tmp), [{ host: '127.0.0.1', port: 1234 }])).not.toThrow();
      expect(warnSpy.mock.calls).toEqual([['[Scanner] removePersistedProviders failed; discovery cache was not cleaned up']]);
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
