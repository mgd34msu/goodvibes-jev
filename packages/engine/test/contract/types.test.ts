/**
 * The contract data model's status transition tables (design 2.3): every
 * status has a row, every listed move is applied, every unlisted move throws
 * without changing the status, and terminal statuses have no exits.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_GROUP_STATUSES,
  CONTRACT_STATUSES,
  CONTRACT_TRANSITIONS,
  CONTRACT_UNIT_STATUSES,
  GROUP_TRANSITIONS,
  IllegalContractTransitionError,
  UNIT_TRANSITIONS,
  isContractId,
  isTerminalContractStatus,
  isTerminalGroupStatus,
  isTerminalUnitStatus,
  newContractId,
  transitionContract,
  transitionGroup,
  transitionUnit,
  type Contract,
  type ContractGroup,
  type ContractUnit,
} from '../../sdk/src/platform/contract/index.js';

type Table = Readonly<Record<string, readonly string[]>>;

interface Subject {
  readonly name: 'contract' | 'group' | 'unit';
  readonly statuses: readonly string[];
  readonly table: Table;
  readonly terminal: readonly string[];
  readonly isTerminal: (status: string) => boolean;
  readonly apply: (from: string, to: string) => { readonly target: { status: string }; readonly result: () => unknown };
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'contract',
    statuses: CONTRACT_STATUSES,
    table: CONTRACT_TRANSITIONS,
    terminal: ['passed', 'failed', 'cancelled'],
    isTerminal: (status) => isTerminalContractStatus(status as Contract['status']),
    apply: (from, to) => {
      const target = { id: 'ctr-00000001', status: from } as unknown as Contract;
      return { target, result: () => transitionContract(target, to as Contract['status']) };
    },
  },
  {
    name: 'group',
    statuses: CONTRACT_GROUP_STATUSES,
    table: GROUP_TRANSITIONS,
    terminal: ['passed', 'failed', 'cancelled'],
    isTerminal: (status) => isTerminalGroupStatus(status as ContractGroup['status']),
    apply: (from, to) => {
      const target = { id: 'g1', status: from } as unknown as ContractGroup;
      return { target, result: () => transitionGroup(target, to as ContractGroup['status']) };
    },
  },
  {
    name: 'unit',
    statuses: CONTRACT_UNIT_STATUSES,
    table: UNIT_TRANSITIONS,
    terminal: ['passed', 'failed', 'cancelled'],
    isTerminal: (status) => isTerminalUnitStatus(status as ContractUnit['status']),
    apply: (from, to) => {
      const target = { id: 'u1', status: from } as unknown as ContractUnit;
      return { target, result: () => transitionUnit(target, to as ContractUnit['status']) };
    },
  },
];

for (const subject of SUBJECTS) describe(`${subject.name} transitions`, () => {
  test('the table has exactly one row per status, and every target is a status', () => {
    expect(Object.keys(subject.table).sort()).toEqual([...subject.statuses].sort());
    for (const targets of Object.values(subject.table)) {
      for (const to of targets) expect(subject.statuses).toContain(to);
    }
  });

  test('passed, failed and cancelled are terminal and have no exits; nothing else is terminal', () => {
    for (const status of subject.statuses) {
      const terminal = subject.terminal.includes(status);
      expect(subject.isTerminal(status)).toBe(terminal);
      expect(subject.table[status]!.length === 0).toBe(terminal);
    }
  });

  test('every non-terminal status can fail and be cancelled', () => {
    for (const status of subject.statuses) {
      if (subject.terminal.includes(status)) continue;
      expect(subject.table[status]).toContain('failed');
      expect(subject.table[status]).toContain('cancelled');
    }
  });

  test('every listed move is applied and reported', () => {
    for (const from of subject.statuses) {
      for (const to of subject.table[from]!) {
        const { target, result } = subject.apply(from, to);
        expect(result()).toEqual({ from, to });
        expect(target.status).toBe(to);
      }
    }
  });

  test('every move not in the table throws and leaves the status unchanged', () => {
    let refused = 0;
    for (const from of subject.statuses) {
      for (const to of subject.statuses) {
        if (subject.table[from]!.includes(to)) continue;
        const { target, result } = subject.apply(from, to);
        expect(result).toThrow(IllegalContractTransitionError);
        expect(target.status).toBe(from);
        refused += 1;
      }
    }
    // Self-moves alone are one refusal per status.
    expect(refused).toBeGreaterThanOrEqual(subject.statuses.length);
  });
});

describe('the rules the runner relies on', () => {
  test('a unit reaches passed only from a check, a best-of-N selection, or owner confirmation', () => {
    const into = CONTRACT_UNIT_STATUSES.filter((from) => UNIT_TRANSITIONS[from].includes('passed'));
    expect(into.sort()).toEqual(['awaiting-owner', 'checking', 'held', 'held-merge']);
  });

  test('a contract passes only from committing, and commits only from judging or, on resume, from the queue', () => {
    expect(CONTRACT_STATUSES.filter((from) => CONTRACT_TRANSITIONS[from].includes('passed'))).toEqual(['committing']);
    expect(CONTRACT_STATUSES.filter((from) => CONTRACT_TRANSITIONS[from].includes('committing'))).toEqual(['queued', 'judging']);
  });

  test('an illegal move names the subject, its id and both statuses', () => {
    const contract = { id: 'ctr-0000abcd', status: 'passed' } as unknown as Contract;
    try {
      transitionContract(contract, 'running');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalContractTransitionError);
      const illegal = error as IllegalContractTransitionError;
      expect([illegal.subject, illegal.subjectId, illegal.from, illegal.to]).toEqual(['contract', 'ctr-0000abcd', 'passed', 'running']);
      expect(illegal.message).toBe('Illegal contract transition: passed -> running for contract ctr-0000abcd');
    }
  });
});

describe('contract ids', () => {
  test('newContractId is ctr- and eight hex digits, and ids differ', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newContractId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isContractId(id)).toBe(true);
  });

  test('isContractId refuses anything that could name another path', () => {
    for (const bad of ['ctr-0000000', 'ctr-0000000g', 'CTR-00000000', '../ctr-00000000', 'ctr-00000000/..', 'ctr-00000000.json', '', 7, null]) {
      expect(isContractId(bad)).toBe(false);
    }
  });
});
