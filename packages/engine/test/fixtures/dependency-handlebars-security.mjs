import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const verdaccioRequire = createRequire(require.resolve('verdaccio'));
const hooksRequire = createRequire(verdaccioRequire.resolve('@verdaccio/hooks'));
const handlebars = hooksRequire('handlebars');

assert.equal(hooksRequire('handlebars/package.json').version, '4.7.10');
// Preserve hooks string-template rendering and general AST/precompile compatibility.
const template = 'Package {{name}} by {{publisher.name}}: {{#each versions}}{{this}} {{/each}}';
const context = { name: '<fixture>', publisher: { name: 'local' }, versions: ['1.0.0', '1.0.1'] };
const expected = 'Package &lt;fixture&gt; by local: 1.0.0 1.0.1 ';
assert.equal(handlebars.compile(template)(context), expected);
const { compileTemplate } = hooksRequire('./notify.js');
assert.equal(await compileTemplate(template, context), expected);
assert.equal(handlebars.compile(handlebars.parse(template))(context), expected);
// Only evaluate output from our constant, trusted template.
const compiled = new Function(`return (${handlebars.precompile(template)});`)();
assert.equal(handlebars.template(compiled)(context), expected);

// GHSA-8r5x-fm3f-whwj: malformed AST blockParams must not become JS.
for (const compile of [handlebars.compile, handlebars.precompile]) {
  const ast = handlebars.parse('{{#if enabled}}safe{{/if}}');
  ast.body[0].program.blockParams = { length: '(()=>{throw new Error("AST_INJECTION_EXECUTED")})()' };
  assert.throws(() => {
    const result = compile(ast);
    if (typeof result === 'function') result({ enabled: true });
  }, error => !error.message.includes('AST_INJECTION_EXECUTED'));
}

// GHSA-p8wg-vrv2-v86f: an own constructor on a prototype must not bypass
// the deny list, even when the caller allows prototype methods generally.
const lookup = handlebars.compile('{{#if (lookup fn "constructor")}}EXPOSED{{else}}BLOCKED{{/if}}');
assert.equal(lookup({ fn: Function.prototype }, { allowProtoMethodsByDefault: true }), 'BLOCKED');
assert.equal(handlebars.compile('{{lookup record "name"}}')({ record: { name: 'allowed' } }), 'allowed');
console.log('VERDACCIO_HANDLEBARS_SECURITY_AND_COMPATIBILITY_OK');
