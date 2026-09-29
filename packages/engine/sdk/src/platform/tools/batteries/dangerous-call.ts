/**
 * `engine.tools.dangerous-call`: analyze mode `permissions` finds candidate
 * lines with call-shape patterns (eval, new Function, exec/execSync/spawn,
 * chmod 777, dangerouslySetInnerHTML, document.write, innerHTML assignment,
 * new RegExp over a non-literal); these readings decide whether the matched
 * call is actually risky where it stands (`risky`) and how severe it is
 * (`severity`), in one request. They replace reporting every match with a
 * severity hand-assigned per pattern (eval, exec and chmod high; HTML sinks
 * medium; RegExp low), which reported `regex.exec(` and a constant
 * `innerHTML = ''` the same as code that runs or injects outside input.
 *
 * The patterns stay only as the shortlist (they choose which lines are read,
 * never what is reported or how severe it is).
 *
 * Band: medium stakes. A wrong no hides a risky call from the report. Code
 * reports a candidate unless `risky` is a no (uncertain ones are listed as
 * needing review) and reports `severity` only when that reading acts or
 * confirms, else `unrated`.
 */
import { defineBattery, oneOf, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const DANGER_SEVERITY_OPTIONS = {
  high: 'Runs code or shell commands built from input the program does not control, or opens files or permissions to everyone.',
  medium: 'Injects HTML or script built from data into a page, or runs a command or dynamic code whose input is only partly controlled.',
  low: 'A risky construct whose inputs are fixed or trusted, where harm needs another mistake first (for example a regular expression built from configuration).',
} as const;

export type DangerSeverity = keyof typeof DANGER_SEVERITY_OPTIONS;

const at = (file: string, line: string, before: string[] = [], after: string[] = []) => ({ file, line, before, after });

export const dangerousCall = defineBattery({
  name: 'engine.tools.dangerous-call',
  version: 1,
  description: 'Whether a line a dangerous-call pattern matched is actually risky in context, and how severe it is.',
  accuracyFloor: 0.85,
  items: {
    risky: yesNo(
      '`line` is a line of the source file `file` (with the lines `before` and `after` it) that a scan matched as a possibly dangerous call. Is it actually a risky call: running dynamic code (eval, new Function), running a shell command or process, making files or directories writable by everyone, writing unescaped HTML into a page, or building a regular expression from outside input? A different function that only shares the name (a regex .exec method, a database query exec), clearing an element with an empty string, or a call in a comment or string is not risky.',
      STAKES_BANDS.medium.yesNo,
    ),
    severity: oneOf(
      '`line` is a line of the source file `file` (with the lines `before` and `after` it) holding a possibly dangerous call. How severe is the risk it carries?',
      DANGER_SEVERITY_OPTIONS,
      STAKES_BANDS.medium.confidence,
    ),
  },
  fixtures: [
    { name: 'eval of request body', state: at('src/routes/calc.ts', '  const result = eval(req.body.expression);', ["app.post('/calc', (req, res) => {"]), expect: { risky: 'yes', severity: 'high' } },
    { name: 'exec with interpolated user input', state: at('src/tools/convert.ts', '  execSync(`convert ${req.query.file} out.png`);', ['export function convert(req: Request) {']), expect: { risky: 'yes', severity: 'high' } },
    { name: 'chmod 777', state: at('scripts/setup.js', "fs.chmodSync('/var/app/uploads', 0o777);", []), expect: { risky: 'yes', severity: 'high' } },
    { name: 'innerHTML from a comment body', state: at('src/ui/comments.js', '  el.innerHTML = comment.body;', ['function renderComment(el, comment) {']), expect: { risky: 'yes', severity: 'medium' } },
    { name: 'dangerouslySetInnerHTML with post html', state: at('src/components/Post.tsx', '  return <div dangerouslySetInnerHTML={{ __html: post.html }} />;', ['export function Post({ post }: Props) {']), expect: { risky: 'yes', severity: 'medium' } },
    { name: 'spawn of a fixed command', state: at('scripts/build.ts', "const child = spawn('bun', ['run', 'build'], { stdio: 'inherit' });", []), expect: { risky: 'yes', severity: 'low' } },
    { name: 'regexp from a config value', state: at('src/router.ts', 'const matcher = new RegExp(config.routePattern);', ["const config = loadConfig('routes.json');"]), expect: { risky: 'yes', severity: 'low' } },
    { name: 'regex exec method', state: at('src/parse.ts', '  while ((match = pattern.exec(text)) !== null) {', ['  const pattern = /\\d+/g;']), expect: { risky: 'no' } },
    { name: 'clear an element', state: at('src/ui/list.js', "  list.innerHTML = '';", ['function reset(list) {']), expect: { risky: 'no' } },
    { name: 'eval in a comment', state: at('src/sandbox.ts', '// Never call eval() on user input; use the parser below.', []), expect: { risky: 'no' } },
    { name: 'database exec method', state: at('src/db/migrate.ts', "  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)');", ['export function migrate(db: Database) {']), expect: { risky: 'no' } },
  ],
});
