/**
 * Coverage-gap smoke test, platform/runtime/forensics
 * Verifies that classifier, collector, and registry modules load correctly.
 * Closes coverage gap: platform/runtime/forensics
 */

import { describe, expect, test } from 'bun:test';
import { classifyFailure } from '../sdk/src/platform/runtime/forensics/classifier.js';
import { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '../sdk/src/platform/runtime/forensics/registry.js';

describe('platform/runtime/forensics: classifier and registry behavior', () => {
  test('DEFAULT_REGISTRY_LIMIT is a positive number', () => {
    expect(DEFAULT_REGISTRY_LIMIT).toBeGreaterThan(0);
  });

  test('ForensicsRegistry instance exposes expected methods', () => {
    const reg = new ForensicsRegistry();
    expect(reg.count()).toBe(0);
    expect(reg.getAll()).toHaveLength(0);
    expect(reg.latest()).toBeNull();
  });

  test('classifyFailure reads a normal stop with no error message as unknown, without a judgment port', async () => {
    const result = await classifyFailure({
      stopReason: 'end_turn',
      errorMessage: undefined,
      wasCancelled: false,
      hasCascadeEvents: false,
      hasToolFailure: false,
      hasPermissionDenial: false,
      hasCompactionError: false,
    });
    expect(result).toBe('unknown');
  });
});
