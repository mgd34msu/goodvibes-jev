import { expect, test } from 'bun:test';
import { normalizeLiteralUnionOrder } from '../scripts/literal-union-order.ts';
import { diffSnapshots, sameApiSurface, type ExportEntry, type Snapshot } from '../scripts/subpath-api-surface-rule.ts';

const entry = (text: string, overrides: Partial<ExportEntry> = {}): ExportEntry => ({ name: 'Example', kind: 'type', text, ...overrides });
const snapshot = (value: ExportEntry): Snapshot => ({ '.': [value] });
const same = (before: string, after: string) => sameApiSurface(snapshot(entry(before)), snapshot(entry(after)));

test('equivalent emitted literal alternatives compare equally, including referenced definitions', () => {
  const before = 'export declare const ownerReply: ReplyReader<"approve" | "amend" | "reject">;';
  const after = 'export declare const ownerReply: ReplyReader<"approve" | "reject" | "amend">;';
  expect(same(before, after)).toBe(true);
  expect(diffSnapshots(snapshot(entry(before)), snapshot(entry(after)))).toEqual([]);
  expect(same('export type Example = -1 | 0 | 2 | false | true | null;', 'export type Example = true | 2 | null | false | -1 | 0;')).toBe(true);
  expect(same('catalog: Readonly<{ word: "z" | "a"; }> ;; via Extra = export type Extra = "two" | "one";',
    'catalog: Readonly<{ word: "a" | "z"; }> ;; via Extra = export type Extra = "one" | "two";')).toBe(true);
});

test('literal member edits and multiplicity remain visible', () => {
  const baseline = 'export type Example = "a" | "b" | "a";';
  expect(same(baseline, 'export type Example = "a" | "a" | "b";')).toBe(true);
  for (const changed of ['"a" | "b"', '"a" | "a"', '"a" | "a" | "b" | "c"', '"a" | "a" | "B"']) {
    expect(same(baseline, `export type Example = ${changed};`)).toBe(false);
    expect(diffSnapshots(snapshot(entry(baseline)), snapshot(entry(`export type Example = ${changed};`))).length).toBeGreaterThan(0);
  }
});

test('type operators, nonliteral alternatives, declaration structure and report metadata stay exact', () => {
  const pairs = [
    ['export type Example = A | B;', 'export type Example = B | A;'],
    ['export type Example = keyof A | B;', 'export type Example = A | keyof B;'],
    ['export type Example = ("a" | "b")[];', 'export type Example = "a" | "b"[];'],
    ['export declare function f(a: string): void;', 'export declare function f(a?: string): void;'],
    ['export declare function f(a: string): 1; export declare function f(a: number): 2;', 'export declare function f(a: number): 2; export declare function f(a: string): 1;'],
    ['export type Example = "a  b" | "z";', 'export type Example = "a b" | "z";'],
  ];
  for (const [before, after] of pairs) expect(same(before!, after!)).toBe(false);
  const original = entry('export interface Example { member: "b" | "a"; }', { kind: 'interface', required: ['member'], publicMembers: ['member'] });
  for (const delta of [{ name: 'Renamed' }, { kind: 'class' }, { required: [] }, { publicMembers: [] }]) {
    expect(sameApiSurface(snapshot(original), snapshot({ ...original, ...delta }))).toBe(false);
  }
  expect(sameApiSurface(snapshot(original), {})).toBe(false);
  expect(sameApiSurface(snapshot(original), { '.': [] })).toBe(false);
});

test('quoted metadata, malformed declarations and template interpolation are never rewritten as structure', () => {
  const quoted = 'export type Example = " ;; via Alias = export type Alias = b | a" | "x";';
  expect(normalizeLiteralUnionOrder(quoted)).toContain('" ;; via Alias = export type Alias = b | a"');
  for (const unknown of ['export type Example = "b" | ;', 'export type Example = { a: "b" | "a";', 'export type Example = `prefix${"b" | "a"}`;']) {
    expect(normalizeLiteralUnionOrder(unknown)).toBe(unknown);
  }
});
