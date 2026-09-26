import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOperatorContractPath, getPeerContractPath } from '../contracts/dist/node.js';

describe('contracts portability', () => {
  test('default browser-facing entries do not depend on node builtins', () => {
    const runtimeNeutralEntries = [
      'contracts/dist/index.js',
      'errors/dist/index.js',
      'operator-sdk/dist/index.js',
      'peer-sdk/dist/index.js',
      'sdk/dist/index.js',
      'sdk/dist/browser.js',
      'sdk/dist/browser-homeassistant.js',
      'sdk/dist/browser-knowledge.js',
      'sdk/dist/react-native.js',
      'transport-core/dist/index.js',
      'transport-http/dist/index.js',
      'transport-realtime/dist/index.js',
    ];

    for (const entry of runtimeNeutralEntries) {
      const content = readFileSync(resolve(import.meta.dir, '..', entry), 'utf8');
      expect(content.includes("from 'node:")).toBe(false);
      expect(content.includes('from "node:')).toBe(false);
      expect(content.includes("require('node:")).toBe(false);
      expect(content.includes('require("node:')).toBe(false);
    }
  });

  test('node helpers still expose raw artifact paths', () => {
    expect(getOperatorContractPath()).toEndWith('/packages/engine/contracts/artifacts/operator-contract.json');
    expect(getPeerContractPath()).toEndWith('/packages/engine/contracts/artifacts/peer-contract.json');
  });
});
