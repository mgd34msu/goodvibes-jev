import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preserveDeclaredReadReceipts, readPrivateReceiptArchives, readNativePrivateReceiptArchives } from '../../sdk/src/platform/contract/private-read-receipts.js';
import type { ContractView } from '../../sdk/src/platform/contract/types.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = makeRepo(); roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  const relativePath = '.goodvibes/reviews/ctr-abcd1234/source-receipts.json';
  const observations = [{ path: 'review-artifacts/repository-review/findings.json', returnedRanges: ['1-2'], returnedLines: 2,
    contentKind: 'declared-reference' as const, returnedContent: '1 | {"followUpReturnedReadLedger":{"ranges":["11-23"]}}\n2 | private original receipt provenance' }];
  const contract = { id: 'ctr-abcd1234', projectRoot: root, units: [
    { id: 'u1', status: 'passed', files: [], checks: [{ id: 'u1.k3' }], readEvidence: observations },
    { id: 'u2', status: 'running', files: [relativePath], checks: [], readEvidence: [] },
  ] } as unknown as ContractView;
  return { root, relativePath, path: join(root, relativePath), observations, contract };
}

test('declared read receipts are archived privately by the host and survive worker disposal', () => {
  const f = fixture();
  preserveDeclaredReadReceipts(f.contract);
  const stored = readFileSync(f.path);
  const archive = JSON.parse(stored.toString());
  expect(archive.units).toEqual([{ id: 'u1', latestCheckId: 'u1.k3', observations: f.observations }]);
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(git(f.root, 'check-ignore', f.relativePath).trim()).toBe(f.relativePath);
  const receipt = readPrivateReceiptArchives(f.contract);
  expect(receipt[0]).toMatchObject({ path: f.relativePath, bytes: stored.length, archivedUnits: [{ id: 'u1', observations: 1,
    retainedReferences: ['review-artifacts/repository-review/findings.json'] }] });
  expect(JSON.stringify(receipt)).not.toContain('private original receipt provenance');
  expect(JSON.stringify(receipt)).not.toContain('11-23');
  const native = readNativePrivateReceiptArchives(f.contract, [f.relativePath, 'review-artifacts/repository-review/findings.json']);
  expect(native[0]).toMatchObject({ retainedPrivateReferences: [{ unitId: 'u1', checkedAt: 'u1.k3',
    path: f.observations[0]!.path, returnedRanges: ['1-2'], returnedLines: 2, returnedContent: f.observations[0]!.returnedContent }] });
  expect(readNativePrivateReceiptArchives(f.contract, ['review-artifacts/repository-review/findings.json'])).toEqual(receipt);
  expect(f.contract.units[0]!.readEvidence).toEqual(f.observations);
  preserveDeclaredReadReceipts(f.contract);
  expect(readFileSync(f.path)).toEqual(stored);
});

test('unregistered reserved paths grant no host archive operation', () => {
  const f = fixture();
  const other = { ...f.contract, units: [{ ...f.contract.units[1]!, files: ['.goodvibes/settings.json'] }] };
  preserveDeclaredReadReceipts(other);
  expect(existsSync(f.path)).toBe(false);
  expect(readPrivateReceiptArchives(other)).toEqual([]);
});

test('private receipt archival refuses redirected directories and unrelated existing files', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.goodvibes'), { recursive: true });
  mkdirSync(join(f.root, 'other'));
  symlinkSync(join(f.root, 'other'), join(f.root, '.goodvibes/reviews'));
  expect(() => preserveDeclaredReadReceipts(f.contract)).toThrow('redirected');
  expect(existsSync(join(f.root, 'other/ctr-abcd1234/source-receipts.json'))).toBe(false);
  rmSync(join(f.root, '.goodvibes/reviews'));
  mkdirSync(join(f.root, '.goodvibes/reviews/ctr-abcd1234'), { recursive: true });
  writeFileSync(f.path, '{"owner":"someone else"}');
  expect(() => preserveDeclaredReadReceipts(f.contract)).toThrow('unrecognized owner');
  expect(readFileSync(f.path, 'utf8')).toBe('{"owner":"someone else"}');
});
