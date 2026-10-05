import { describe, expect, test } from 'bun:test';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import inspectionSchema from '../../src/lib/generated/contract-inspection-schema.json';
import { CAPTURED_CONTRACTS, malformedCapturedRecords } from './native-contract-records';

describe('real contract REST capture provenance', () => {
  for (const fixture of CAPTURED_CONTRACTS) {
    test(`${fixture.name}: complete GET and LIST agree and strict malformed responses fail`, () => {
      const list: unknown = JSON.parse(fixture.listBody);
      expect(list).toEqual({ contracts: [fixture.record] });
      expect(JSON.parse(fixture.getBody)).toEqual(fixture.record);
      expect(firstJsonSchemaFailure(inspectionSchema, fixture.record)).toBeUndefined();
      for (const malformed of malformedCapturedRecords(fixture.record)) {
        expect(firstJsonSchemaFailure(inspectionSchema, malformed.value), malformed.name).toBeDefined();
      }
    });
  }
  test('the ordinary capture retains the runner-parsed report; retry capture is not a semantic defer', () => {
    const ordinary = CAPTURED_CONTRACTS[0].record;
    expect(ordinary.units[0]?.lastReport).toMatchObject({ version: 1, archetype: 'engineer', summary: 'Implemented the CSV parser' });
    expect(ordinary.units[0]?.lastOutput).toContain('"summary":"Implemented the CSV parser"');
    expect(ordinary.inputSnapshot?.files.some((file) => file.path === 'README.md')).toBe(true);
    const waiting = CAPTURED_CONTRACTS[2].record;
    expect(waiting.nativeProgress?.state).toBe('deciding');
    expect(waiting.nativeWaiting?.requests[0]?.attempt.status).toBe(503);
    expect(waiting.nativeWaiting?.requests[0]?.nextDelayMs).toBe(60_000);
    expect(waiting.nativeDecisions?.history).toEqual([]);
    expect(waiting.nativeDecisions?.pending).toEqual({});
  });
  test('partial reports preserve optional-field absence, long parsed output and cross-archetype file claims', () => {
    const engineer = CAPTURED_CONTRACTS.find((fixture) => fixture.name === 'partial-engineer-report-worktree')?.record.units[0];
    expect(engineer?.lastReport).toMatchObject({ version: 1, archetype: 'engineer', filesCreated: ['src/csv.ts'] });
    expect(engineer?.lastReport).not.toHaveProperty('gatheredContext');
    expect(engineer?.lastReport?.summary?.length).toBe(28_018);
    expect(engineer?.lastOutput?.length).toBe(12_036);
    const researcher = CAPTURED_CONTRACTS.find((fixture) => fixture.name === 'partial-researcher-report-worktree')?.record.units[0];
    expect(researcher?.lastReport).toEqual({ version: 1, archetype: 'researcher', summary: 'Recorded file claims on a generic report.', filesCreated: ['src/csv.ts'], filesModified: [], filesDeleted: [] });
    expect(researcher?.checks.some((check) => check.claims?.kind === 'files_verified')).toBe(true);
  });

});
