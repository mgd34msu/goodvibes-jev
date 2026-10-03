import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface Ast { type: string; value?: string; nodes?: Ast[] }
interface Braces {
  parse(input: string, options?: object): Ast;
  compile(input: string | Ast, options?: object): string;
  expand(input: string | Ast, options?: object): string[];
  stringify(input: string | Ast, options?: object): string;
}
const require = createRequire(import.meta.url);
const bashRoot = dirname(require.resolve('bash-language-server/package.json'));
const source = 'vendor/fast-glob/vendor/micromatch/vendor/braces';
const installedRoot = join(bashRoot, source);
const braces = require(installedRoot) as Braces;
const nested = (depth: number, left = '{', right = '}'): string => left.repeat(depth) + 'fixture' + right.repeat(depth);

describe('vendored braces depth guard', () => {
  test('the installed Bash discovery chain carries the reviewed guard', () => {
    expect(readFileSync(join(installedRoot, 'lib/nesting.js'), 'utf8')).toBe(readFileSync(require.resolve(`../../../vendor/bash-language-server/${source}/lib/nesting.js`), 'utf8'));
  });

  test('preserves ordinary expansion, ranges, nesting, quoting and escaped delimiters', () => {
    expect(braces.expand('a/{b,c}/{1..2}')).toEqual(['a/b/1', 'a/b/2', 'a/c/1', 'a/c/2']);
    expect(braces.expand('{x,{y,z}}')).toEqual(['x', 'y', 'z']);
    expect(() => braces.compile(nested(127))).not.toThrow();
    expect(() => braces.expand(nested(127))).not.toThrow();
    expect(() => braces.compile(nested(127, '(', ')'))).not.toThrow();
    expect(() => braces.compile(`"${nested(200)}"`)).not.toThrow();
    expect(() => braces.compile('\\{'.repeat(200) + 'fixture' + '\\}'.repeat(200))).not.toThrow();
  });

  for (const method of ['parse', 'compile', 'expand', 'stringify'] as const) {
    test(`${method} rejects excessive mixed/brace/parenthesis nesting with a controlled SyntaxError`, () => {
      for (const input of [nested(128), nested(128, '(', ')'), '{('.repeat(70) + 'fixture' + ')}'.repeat(70), '{'.repeat(200)]) {
        expect(() => braces[method](input)).toThrow(SyntaxError);
        expect(() => braces[method](input, { maxDepth: Infinity, maxLength: 65536 })).toThrow('maximum AST depth');
      }
    });
  }

  for (const method of ['compile', 'expand', 'stringify'] as const) {
    test(`${method} also guards caller-supplied ASTs and direct library entry points`, () => {
      let ast: Ast = { type: 'text', value: 'fixture' };
      for (let i = 0; i < 129; i++) ast = { type: 'root', nodes: [ast] };
      expect(() => braces[method](ast)).toThrow('maximum AST depth');
      const direct = require(join(installedRoot, 'lib', `${method}.js`)) as (input: Ast) => unknown;
      expect(() => direct(ast)).toThrow('maximum AST depth');
      const cyclic: Ast = { type: 'root', nodes: [] };
      cyclic.nodes?.push(cyclic);
      expect(() => direct(cyclic)).toThrow('Cyclic brace AST');
    });
  }
});
