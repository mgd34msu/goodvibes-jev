/**
 * `engine.tools.dangerous-line`: analyze mode `permissions` reads each block
 * of a file's lines with this existence check: which line, if any, makes a
 * risky call. The line it finds is then read by `engine.tools.dangerous-call`,
 * which decides whether it is reported and how severe it is. It replaces the
 * eight call-shape regexes (eval, new Function, exec/execSync/spawn, chmod
 * 777, dangerouslySetInnerHTML, document.write, innerHTML assignment, new
 * RegExp over a non-literal) that chose which lines were ever read, so a
 * risky call in any other shape (`fs.chmodSync(path, 0o777)`, `execFile`,
 * `vm.runInNewContext`, `insertAdjacentHTML`) was never reported.
 *
 * Band: medium stakes, as `engine.tools.dangerous-call`. A wrong no hides a
 * risky call from the report; a wrong yes costs one more reading of a
 * harmless line. Code keeps reading a block until the check reads no (each
 * found line leaves the block before the next check).
 */
import { defineExistence, STAKES_BANDS, type Item } from '@goodvibes-jev/judgment';

/** The question the existence check answers about one block of `file`. */
export function dangerousLineQuery(file: string): string {
  return `The items are numbered lines of the source file ${file}. Which line makes a risky call: running dynamic code (eval, new Function, vm.runIn*Context), running a shell command or child process, making files or directories writable by everyone, writing unescaped HTML into a page, or building a regular expression from outside input? A different function that only shares a name (a regex .exec method, a database exec), clearing an element with an empty string, and mentions in comments or strings do not count.`;
}

const lines = (...texts: string[]): Item[] => texts.map((text, index) => ({ id: `L${index + 1}`, text }));

export const dangerousLine = defineExistence({
  name: 'engine.tools.dangerous-line',
  version: 1,
  description: 'Which line of a block of source lines, if any, makes a risky call.',
  accuracyFloor: 0.85,
  band: STAKES_BANDS.medium.yesNo,
  fixtures: [
    {
      name: 'chmodSync to everyone',
      query: dangerousLineQuery('scripts/setup.js'),
      items: lines("const fs = require('node:fs');", "const uploads = '/var/app/uploads';", 'fs.mkdirSync(uploads, { recursive: true });', 'fs.chmodSync(uploads, 0o777);'),
      expect: { exists: 'yes', item: 'L4' },
    },
    {
      name: 'execFile with a request value',
      query: dangerousLineQuery('src/routes/convert.ts'),
      items: lines("app.post('/convert', (req, res) => {", "  execFile('convert', [req.body.input, 'out.png'], (err) => {", '    res.sendStatus(err ? 500 : 200);', '  });', '});'),
      expect: { exists: 'yes', item: 'L2' },
    },
    {
      name: 'vm context run of user code',
      query: dangerousLineQuery('src/sandbox/run.ts'),
      items: lines("import vm from 'node:vm';", 'export function runSnippet(code: string) {', '  return vm.runInNewContext(code, { console });', '}'),
      expect: { exists: 'yes', item: 'L3' },
    },
    {
      name: 'innerHTML from a comment body',
      query: dangerousLineQuery('src/ui/comments.js'),
      items: lines('function renderComment(el, comment) {', "  el.classList.add('comment');", '  el.innerHTML = comment.body;', '}'),
      expect: { exists: 'yes', item: 'L3' },
    },
    {
      name: 'regex exec loop',
      query: dangerousLineQuery('src/parse.ts'),
      items: lines('const pattern = /\\d+/g;', 'let match;', 'while ((match = pattern.exec(text)) !== null) {', '  numbers.push(Number(match[0]));', '}'),
      expect: { exists: 'no' },
    },
    {
      name: 'clearing an element and a comment about eval',
      query: dangerousLineQuery('src/ui/list.js'),
      items: lines('// Never call eval() on user input; use the parser below.', 'function reset(list) {', "  list.innerHTML = '';", '}'),
      expect: { exists: 'no' },
    },
    {
      name: 'ordinary code',
      query: dangerousLineQuery('src/cart.ts'),
      items: lines('export function subtotal(lines: Line[]): number {', '  return lines.reduce((sum, line) => sum + line.total, 0);', '}'),
      expect: { exists: 'no' },
    },
  ],
});
