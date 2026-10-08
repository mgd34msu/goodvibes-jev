import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const verdaccioRequire = createRequire(require.resolve('verdaccio'));
const hooksRequire = createRequire(verdaccioRequire.resolve('@verdaccio/hooks'));
const handlebars = hooksRequire('handlebars');
const { compileTemplate } = hooksRequire('./notify');

assert.equal(hooksRequire('handlebars/package.json').version, '4.7.10');

// Exercise Verdaccio's real notification template compiler with normal package
// metadata, including escaping and block helpers used by registry hooks.
assert.equal(
  await compileTemplate('{{name}}@{{version}} {{#if published}}published{{/if}} {{description}}', {
    name: '@fixture/package', version: '1.0.0', published: true, description: '<safe>',
  }),
  '@fixture/package@1.0.0 published &lt;safe&gt;',
);

// GHSA-8r5x-fm3f-whwj: a non-array Program.blockParams must be rejected before
// its length can become executable code. The sentinel only throws locally.
const malformedAst = handlebars.parse('{{#if ok}}safe{{/if}}');
malformedAst.body[0].program.blockParams = {
  length: "(()=>{throw new Error('HANDLEBARS_INJECTION_SENTINEL')})()",
};
const invalidAst = /Invalid AST: Program blockParams must be an array/;
assert.throws(() => handlebars.compile(malformedAst)({ ok: true }), invalidAst);
assert.throws(() => handlebars.precompile(malformedAst), invalidAst);

// GHSA-p8wg-vrv2-v86f: Function.prototype's own constructor still has to pass
// the deny list even when the caller allows ordinary prototype methods.
assert.equal(
  handlebars.compile('{{#if (lookup (lookup fn "__proto__") "constructor")}}EXPOSED{{else}}BLOCKED{{/if}}')(
    { fn: function fixtureFunction() {} }, { allowProtoMethodsByDefault: true },
  ),
  'BLOCKED',
);
// The hardening must preserve a normal own data property named constructor.
assert.equal(handlebars.compile('{{constructor}}')({ constructor: 'ordinary-context-data' }), 'ordinary-context-data');

console.log('HANDLEBARS_AST_AND_PROTOTYPE_GUARDS_OK');
