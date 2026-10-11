import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deferredBatteryPolicyStatements, internalSourceAnchors } from '../scripts/static-source-anchors.ts';

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
  const unsafe = source.replace("name: 'engine.gates.internal-identifier', version: 2", "name: 'engine.gates.internal-identifier', version: (STAKES_BANDS.high.yesNo.no.actAt = 0.1)");
  expect(deferredBatteryPolicyStatements(unsafe)).toBeNull();
  expect(deferredBatteryPolicyStatements(source.replace("name: 'engine.gates.internal-identifier', version: 2", "name: 'engine.gates.internal-identifier', version: ++STAKES_BANDS.high.yesNo.no.actAt"))).toBeNull();
  expect(deferredBatteryPolicyStatements(source.replace("name: 'engine.gates.internal-identifier', version: 2", "name: 'engine.gates.internal-identifier', version: delete STAKES_BANDS.high.yesNo.no.actAt"))).toBeNull();
});

test('escaped literals and interpolated templates retain original bytes and mechanical lexical values', () => {
  const source = 'const label = "B\\u0037";\nconst message = `wave ${number} coordination`;';
  const anchors = internalSourceAnchors('source.ts', source);
  expect(anchors.find(anchor => anchor.line === 1)).toMatchObject({ text: 'const label = "B\\u0037";', literalValues: ['B7'], lexicalKind: 'source-text' });
  expect(anchors.map(anchor => anchor.text)).toContain('const message = `wave ${number} coordination`;');
});

test('JSON keys and values are offered and Markdown line wraps remain complete paragraphs', () => {
  const json = internalSourceAnchors('config.json', '{"planningLabel":"W3", "count": 4}');
  expect(json).toMatchObject([{ text: '{"planningLabel":"W3", "count": 4}', literalValues: ['planningLabel', 'W3', 'count', '4'] }]);
  expect(internalSourceAnchors('docs/example.md', 'The developer checklist names\nthe private olive-ticket.\n\nProtocol A1 is a technical tag.')).toMatchObject([
    { line: 1, text: 'The developer checklist names\nthe private olive-ticket.', lexicalKind: 'prose' },
    { line: 4, text: 'Protocol A1 is a technical tag.', lexicalKind: 'prose' },
  ]);
});
