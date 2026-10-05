import { describe, expect, test } from 'bun:test';
import { assertFixtureMatchesOperatorContract, ContractShapeError } from './assert-contract-shape';
import { CONTRACT_FIXTURES, isTerminalFixture, WAITING_CONTRACT } from './contract-fixture';

describe('contract inspection fixtures match the engine wire contract', () => {
  test('all detail fixtures and both list scopes conform', () => {
    for (const contract of CONTRACT_FIXTURES) {
      expect(() => assertFixtureMatchesOperatorContract('contracts.get', contract)).not.toThrow();
    }
    for (const includeTerminal of [false, true]) {
      const contracts = CONTRACT_FIXTURES.filter((contract) => includeTerminal || !isTerminalFixture(contract));
      expect(() => assertFixtureMatchesOperatorContract('contracts.list', { contracts })).not.toThrow();
    }
    expect(() => assertFixtureMatchesOperatorContract('contracts.list', { contracts: [] })).not.toThrow();
  });

  test('dropping a required evidence digest is detected', () => {
    const check = { ...WAITING_CONTRACT.checks[0] } as Record<string, unknown>;
    delete check.evidenceDigest;
    expect(() => assertFixtureMatchesOperatorContract('contracts.get', { ...WAITING_CONTRACT, checks: [check] })).toThrow(ContractShapeError);
  });
});
