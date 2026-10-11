import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deferredBatteryPolicyStatements, internalSourceAnchors } from '../scripts/static-source-anchors.ts';
import { captureStaticInputs, staticInputState } from '../scripts/static-source-readings.ts';

test('identifier admission offers complete actual lexical text and excludes syntax-only punctuation', () => {
  const source = '// Developer finding B7 was fixed.\n// Keep the actual register label here.\nconst oliveTicket = "WO-7";\nconst regex = /C[01]/;\nconst value = { ready: true };\n};';
  const anchors = internalSourceAnchors('source.ts', source);
  expect(anchors.map(anchor => anchor.text)).toContain('const oliveTicket = "WO-7";');
  expect(anchors.map(anchor => anchor.text)).toContain('const regex = /C[01]/;');
  expect(anchors.map(anchor => anchor.text)).toContain('// Developer finding B7 was fixed.\n// Keep the actual register label here.');
  expect(anchors.map(anchor => anchor.text)).toContain('const value = { ready: true };');
  expect(anchors.some(anchor => anchor.text === '};')).toBe(false);
  expect(anchors.find(anchor => anchor.line === 3)).toMatchObject({ lexicalKind: 'source-text', col: 1, literalValues: ['WO-7'] });
});

test('shared-file policy carveout rejects internal declaration side effects', () => {
  const source = readFileSync(new URL('../scripts/batteries/static-source.ts', import.meta.url), 'utf8');
  expect(deferredBatteryPolicyStatements(source)).not.toBeNull();
  const unsafe = source.replace("name: 'engine.gates.internal-identifier', version: 3", "name: 'engine.gates.internal-identifier', version: (STAKES_BANDS.high.yesNo.no.actAt = 0.1)");
  expect(unsafe).not.toBe(source);
  expect(deferredBatteryPolicyStatements(unsafe)).toBeNull();
  expect(deferredBatteryPolicyStatements(source.replace("name: 'engine.gates.internal-identifier', version: 3", "name: 'engine.gates.internal-identifier', version: ++STAKES_BANDS.high.yesNo.no.actAt"))).toBeNull();
  expect(deferredBatteryPolicyStatements(source.replace("name: 'engine.gates.internal-identifier', version: 3", "name: 'engine.gates.internal-identifier', version: delete STAKES_BANDS.high.yesNo.no.actAt"))).toBeNull();
});

test('escaped literals and interpolated templates retain original bytes and mechanical lexical values', () => {
  const source = 'const label = "B\\u0037";\nconst message = `wave ${number} coordination`;';
  const anchors = internalSourceAnchors('source.ts', source);
  expect(anchors.find(anchor => anchor.line === 1)).toMatchObject({ text: 'const label = "B\\u0037";', literalValues: ['B7'], lexicalKind: 'source-text' });
  expect(anchors.map(anchor => anchor.text)).toContain('const message = `wave ${number} coordination`;');
});

test('decoded unpaired UTF-16 remains lossless while every wire string is valid Unicode', () => {
  const source = String.raw`const high = "cmd \uD800 arg";
const low = "\uDC00";
const mixed = "\uD800\uD83D\uDE00\uDC00";
const emoji = "\uD83D\uDE00";
const plain = "unchanged";`;
  const anchors = internalSourceAnchors('unicode-fixture.ts', source);
  const originals = ['cmd \uD800 arg', '\uDC00', '\uD800\uD83D\uDE00\uDC00'];
  for (const [index, original] of originals.entries()) {
    const value = anchors[index]?.literalValues?.[0];
    expect(typeof value).toBe('object');
    if (typeof value !== 'object' || value === null) throw new Error('Expected tagged UTF-16 evidence');
    expect(value.encoding).toBe('utf-16-code-units');
    expect(value.codeUnits).toEqual(Array.from({ length: original.length }, (_, offset) => original.charCodeAt(offset)));
    expect(String.fromCharCode(...value.codeUnits)).toBe(original);
    expect(anchors[index]?.text).toBe(source.split('\n')[index]);
  }
  expect(anchors[3]?.literalValues).toEqual(['\uD83D\uDE00']);
  expect(anchors[4]?.literalValues).toEqual(['unchanged']);
  const input = captureStaticInputs('internal-identifier', 'unicode-fixture.ts', source)[0];
  if (!input) throw new Error('Expected complete source input');
  expect(input.source).toContain(source.split('\n')[0]!);
  const wire: unknown = JSON.parse(JSON.stringify(staticInputState(input)));
  const assertUnicode = (value: unknown): void => {
    if (typeof value === 'string') expect(value.isWellFormed()).toBe(true);
    else if (Array.isArray(value)) for (const child of value) assertUnicode(child);
    else if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) assertUnicode(child);
  };
  assertUnicode(wire);
  if (typeof wire !== 'object' || wire === null || !('anchors' in wire) || !Array.isArray(wire.anchors)) throw new Error('Expected wire anchors');
  expect(wire.anchors).toHaveLength(5);
  expect(wire.anchors[0]).toMatchObject({ literalValues: [{ encoding: 'utf-16-code-units', codeUnits: [99, 109, 100, 32, 55_296, 32, 97, 114, 103] }] });
});

test('JSON keys and values are offered and Markdown line wraps remain complete paragraphs', () => {
  const json = internalSourceAnchors('config.json', '{"planningLabel":"W3", "count": 4}');
  expect(json).toMatchObject([{ text: '{"planningLabel":"W3", "count": 4}', literalValues: ['planningLabel', 'W3', 'count', '4'] }]);
  expect(internalSourceAnchors('docs/example.md', 'The developer checklist names\nthe private olive-ticket.\n\nProtocol A1 is a technical tag.')).toMatchObject([
    { line: 1, text: 'The developer checklist names\nthe private olive-ticket.', lexicalKind: 'prose' },
    { line: 4, text: 'Protocol A1 is a technical tag.', lexicalKind: 'prose' },
  ]);
});
