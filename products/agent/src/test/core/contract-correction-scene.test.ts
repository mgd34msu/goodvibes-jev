import { describe, expect, test } from 'bun:test';
import { correctedContractScene } from '../helpers/contract-correction-scene.ts';
import { projectContractTree } from '../../core/work-tree-contract.ts';

describe('the canonical correction scene retains failed-review history', () => {
  test('every unit belongs to its group and every criterion reading names its own check', () => {
    const contract = correctedContractScene(1_000);
    expect(contract.groups.flatMap((group) => group.unitIds).sort()).toEqual(contract.units.map((unit) => unit.id).sort());
    const allCheckIds = [...contract.checks, ...contract.units.flatMap((unit) => unit.checks)].map((check) => check.id);
    expect(new Set(allCheckIds).size).toBe(allCheckIds.length);
    for (const unit of contract.units) {
      expect(contract.groups.find((group) => group.id === unit.groupId)?.unitIds).toContain(unit.id);
      const checks = new Set(unit.checks.map((check) => check.id));
      for (const criterion of unit.criteria) {
        expect(criterion.id.startsWith(`${unit.id}.`)).toBe(true);
        expect(criterion.readings.every((reading) => checks.has(reading.checkId))).toBe(true);
      }
    }
  });

  test('an unmet cap finding leads to a consumed nudge, linked repair, and later passing recheck', () => {
    const contract = correctedContractScene(1_000);
    const original = contract.units.find((unit) => unit.id === 'u1')!;
    const repair = contract.units.find((unit) => unit.id === 'u1.f1.u1')!;
    expect(original.criteria[0]?.readings.map((reading) => reading.verdict)).toEqual(['unmet', 'met']);
    expect(original.checks.map((check) => [check.trigger, check.result])).toEqual([['completion', 'stall'], ['fix-passed', 'pass']]);
    expect(original.nudges[0]?.text).toContain('Jitter can push the delay past maxDelayMs');
    expect(original.nudges[0]?.criterionIds).toEqual(['u1.c1']);
    expect(original.nudges[0]?.consumedAt).toBeGreaterThan(original.checks[0]!.at);
    expect(contract.groups.find((group) => group.id === repair.groupId)?.repairs).toEqual({ scope: 'unit', targetId: 'u1', criterionIds: ['u1.c1'] });
    expect(repair.criteria[0]?.serves).toEqual(['u1.c1']);
    expect(original.nudges[0]!.consumedAt!).toBeLessThan(repair.checks[0]!.at);
    expect(repair.checks[0]!.at).toBeLessThan(original.checks[1]!.at);
    expect(original.checks[1]!.at).toBeLessThan(contract.completedAt!);
    const detail = projectContractTree(contract).flatMap((row) => row.lines).join('\n');
    expect(detail).toContain('u1.k1 · completion · stall');
    expect(detail).toContain('u1.k2 · fix-passed · pass');
    expect(detail).toContain('bus · consumed');
    expect(detail).toContain('Repair: unit u1 · u1.c1');
  });
});
