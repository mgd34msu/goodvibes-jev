import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

interface Consumer { readonly sources: string[]; eachMapping(callback: (mapping: { generatedLine: number; source: string }) => void): void }
interface SourceMaps {
  SourceMapConsumer: new (map: object) => Consumer;
  SourceMapGenerator: { fromSourceMap(consumer: Consumer): { toString(): string } };
}
const require = createRequire(import.meta.url);
const webuiRequire = createRequire(new URL('../../../products/webui/package.json', import.meta.url));
const consumers = [
  ['jsdom / css-tree', createRequire(createRequire(require.resolve('jsdom')).resolve('css-tree'))],
  ['Vite / PostCSS', createRequire(createRequire(webuiRequire.resolve('vite')).resolve('postcss'))],
] as const;
const flat = { version: 3, sources: ['fixture.js'], names: [], mappings: 'AAAA', sourcesContent: ['fixture();'] };
const indexed = (line: unknown, column: unknown = 0, map: object = flat) => ({
  version: 3, sections: [{ offset: { line, column }, map }],
});

for (const [name, consumerRequire] of consumers) describe(`patched source maps through ${name}`, () => {
  const maps = consumerRequire('source-map-js') as SourceMaps;

  test('resolves the patched version and preserves ordinary maps and indexed locations', () => {
    expect(consumerRequire('source-map-js/package.json').version).toBe('1.2.2');
    const consumer = new maps.SourceMapConsumer(indexed(2));
    expect(consumer.sources).toEqual(['fixture.js']);
    const locations: { generatedLine: number; source: string }[] = [];
    consumer.eachMapping(mapping => locations.push(mapping));
    expect(locations).toHaveLength(1);
    expect(locations[0]?.generatedLine).toBe(3);
    expect(locations[0]?.source).toBe('fixture.js');
    const generated = JSON.parse(maps.SourceMapGenerator.fromSourceMap(new maps.SourceMapConsumer(flat)).toString());
    expect(generated.mappings).toBe('AAAA');
    expect(generated.sources).toEqual(['fixture.js']);
    expect(generated.sourcesContent).toEqual(['fixture();']);
  });

  test('rejects huge and cumulative offsets before any generated-map allocation', () => {
    // Only construct these tiny inputs. Never flatten the unsafe maps, even in
    // a negative-control run against the old package.
    expect(() => new maps.SourceMapConsumer(indexed(10_000_001))).toThrow(/must not exceed/);
    expect(() => new maps.SourceMapConsumer(indexed(6_000_000, 0, indexed(6_000_000))))
      .toThrow(/including offsets of nested sections/);
  });

  test('rejects invalid line and column offsets and preserves bounded nested sources', () => {
    for (const value of [-1, 0.5, Infinity, NaN, '2', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new maps.SourceMapConsumer(indexed(value))).toThrow(/non-negative integers/);
      expect(() => new maps.SourceMapConsumer(indexed(0, value))).toThrow(/non-negative integers/);
    }
    let map: object = flat;
    for (let depth = 0; depth < 8; depth++) map = indexed(0, 0, map);
    expect(new maps.SourceMapConsumer(map).sources).toEqual(['fixture.js']);
  });
});
