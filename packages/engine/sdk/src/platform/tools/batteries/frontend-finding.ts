/**
 * `engine.tools.frontend-finding`: the readings behind the inspect tool's
 * frontend analyzers (tools/inspect/frontend.ts). Code finds the candidates
 * from syntax (an element, a hook call, an overflow or fixed-size utility, an
 * import); each analyzer asks only its own question (`only`) about one
 * candidate with the lines around it:
 *
 * - `a11y_violation` (accessibility): does this element break the named WCAG
 *   rule? Replaces the single-line regexes that reported a missing alt,
 *   accessible name, role or label whenever the attribute was not on the same
 *   line ("may be missing").
 * - `omits_dependency` (hooks): does the hook's dependency array leave out a
 *   value from the component scope that its callback reads? Replaces the
 *   identifier scan with a keyword skip list, a lowercase-first test and a
 *   30-line window.
 * - `overflow_problem` (overflow): does this overflow setting clip content or
 *   fail to scroll because nothing bounds the element's size? Replaces the
 *   "no height class on the same line" test.
 * - `fixed_size_problem` (sizing): is this fixed size likely to break the
 *   layout on a narrow screen? Replaces the cutoffs (Tailwind scale above 96,
 *   CSS pixels above 200).
 * - `server_only` (client boundary, state: a module specifier): can this
 *   module only run on the server? Replaces the three-module list
 *   (server-only, next/headers, next-auth/server).
 * - `stacking_conflict` (stacking, state: one z-index value and every line
 *   that sets it): do these elements overlap in one stacking context, so
 *   their order is left to document order? Replaces reporting every value
 *   used on more than one line as a potential conflict.
 *
 * Band: low stakes. These are review hints in an inspection report; nothing
 * runs or changes on them. Code reports a candidate unless the reading is a
 * no, so an uncertain one is shown rather than hidden.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Lines of context carried on each side of a candidate line. */
export const FRONTEND_CONTEXT_LINES = 3;
/** Most lines of a hook call the omits_dependency reading carries. */
export const MAX_JUDGED_HOOK_LINES = 40;

/** One line that sets a z-index value, with the lines around it. */
export type ZIndexUse = { line: number; text: string; before: string[]; after: string[] };

/** What the stacking reading sees: the file, one z-index value, and each line that sets it. */
export function stackingView(file: string, lines: readonly string[], value: string, lineNumbers: readonly number[]): { file: string; value: string; uses: ZIndexUse[] } {
  return {
    file,
    value,
    uses: lineNumbers.map((line) => ({
      line,
      text: lines[line - 1] ?? '',
      before: lines.slice(Math.max(0, line - 1 - FRONTEND_CONTEXT_LINES), line - 1),
      after: lines.slice(line, line + FRONTEND_CONTEXT_LINES),
    })),
  };
}

/** What a line reading sees: the file, the candidate line, and the lines around it. */
export function frontendLineView(file: string, lines: readonly string[], index: number, extra: Record<string, string> = {}): Record<string, string | string[]> {
  return {
    file,
    ...extra,
    line: lines[index] ?? '',
    before: lines.slice(Math.max(0, index - FRONTEND_CONTEXT_LINES), index),
    after: lines.slice(index + 1, index + 1 + FRONTEND_CONTEXT_LINES),
  };
}

const LOW = STAKES_BANDS.low.yesNo;
const el = (rule: string, line: string, before: string[] = [], after: string[] = []) => ({ file: 'src/components/Card.tsx', rule, line, before, after });
const hook = (code: string) => ({ file: 'src/components/Search.tsx', code });
const at = (line: string, before: string[] = [], after: string[] = []) => ({ file: 'src/components/Panel.tsx', line, before, after });
const stack = (file: string, value: string, content: string, lineNumbers: number[]) => stackingView(file, content.split('\n'), value, lineNumbers);

const MODAL_AND_TOAST = [
  'export function Page() {',
  '  return (',
  '    <>',
  '      <div className="fixed inset-0 z-50 bg-black/50">',
  '        <Dialog />',
  '      </div>',
  '      <div className="fixed bottom-4 right-4 z-50">',
  '        <Toast />',
  '      </div>',
  '    </>',
  '  );',
  '}',
].join('\n');
const MOBILE_OR_DESKTOP_NAV = [
  'export function Navigation({ isMobile }) {',
  '  if (isMobile) {',
  '    return <nav className="fixed bottom-0 inset-x-0 z-30">{mobileLinks}</nav>;',
  '  }',
  '  return <aside className="sticky top-0 h-screen z-30">{desktopLinks}</aside>;',
  '}',
].join('\n');
const HEADER_AND_DROPDOWN = [
  '.site-header {',
  '  position: sticky;',
  '  top: 0;',
  '  z-index: 100;',
  '}',
  '',
  '.account-menu {',
  '  position: absolute;',
  '  top: 3rem;',
  '  z-index: 100;',
  '}',
].join('\n');
const TWO_ROUTES = [
  "// settings/page.tsx and checkout/page.tsx share this file's exports",
  'export function SettingsPage() {',
  '  return <aside className="sticky top-0 z-20">{settingsNav}</aside>;',
  '}',
  '',
  'export function CheckoutPage() {',
  '  return <footer className="sticky bottom-0 z-20">{orderTotal}</footer>;',
  '}',
].join('\n');

export const frontendFinding = defineBattery({
  name: 'engine.tools.frontend-finding',
  version: 2,
  description: 'Whether a frontend inspection candidate is a real issue: an accessibility violation, a missing hook dependency, an overflow problem, a fixed size that breaks narrow layouts, a server-only import, or a z-index value shared by overlapping elements.',
  accuracyFloor: 0.85,
  items: {
    a11y_violation: yesNo(
      '`line` (with the lines `before` and `after` it) is JSX or HTML from `file`. Does the element that starts on `line` break the accessibility rule `rule`, looking at the whole element, which may continue on the following lines? It does not break the rule when the needed attribute, text content or label is present anywhere on the element or, for a form field, in a wrapping or linked label.',
      LOW,
    ),
    omits_dependency: yesNo(
      '`code` is a React useEffect, useMemo or useCallback call from `file`. Does its dependency array leave out a value from the component scope that the callback reads: a prop, state value, or variable or function declared in the component body? Values declared inside the callback, imports, module constants, globals, and state setter functions do not need to be listed.',
      LOW,
    ),
    overflow_problem: yesNo(
      '`line` (with the lines `before` and `after` it) from `file` sets overflow on an element. Is this a layout problem of either kind: (1) hidden overflow on a box whose real content (text, a list, user data) can grow past the box, so part of it is cut off with no way to reach it; or (2) a scrolling setting (auto or scroll) on an element whose height or width nothing bounds, so it grows instead of ever scrolling? Hiding overflow to crop an image, round corners or clip decoration, and scrolling on a box with a fixed or maximum size, are not problems.',
      LOW,
    ),
    fixed_size_problem: yesNo(
      '`line` (with the lines `before` and `after` it) from `file` gives an element a fixed width or height. Is this fixed size likely to break the layout on a narrow phone screen, for example a wide fixed width on a content container with no responsive override or max-width? Small fixed sizes for icons, avatars, borders and spacing, and sizes that are overridden at small breakpoints, are not problems.',
      LOW,
    ),
    server_only: yesNo(
      '`module` is the specifier of a JavaScript or TypeScript import in a web app. Can this module only run on the server, so importing it into a client component or browser bundle fails or leaks server code (for example Node built-ins, database drivers, server-only packages, or framework server APIs such as request headers and cookies)?',
      LOW,
    ),
    stacking_conflict: yesNo(
      '`value` is a z-index value that `file` sets on more than one element; `uses` lists each line that sets it, with the lines `before` and `after` it. Do two or more of these elements overlap on screen in the same stacking context, so that which one paints on top is left to their order in the document rather than set by different z-index values? Elements that are never on screen together (on different pages, routes or screens) or never overlap, and elements in separate stacking contexts, do not conflict.',
      LOW,
    ),
  },
  fixtures: [
    { name: 'img without alt', state: el('img-alt: images need an alt attribute', '<img src={product.photo} className="w-full" />'), expect: { a11y_violation: 'yes' } },
    { name: 'img with alt on the next line', state: el('img-alt: images need an alt attribute', '<img', [], ['  src={product.photo}', '  alt={product.name}', '/>']), expect: { a11y_violation: 'no' } },
    { name: 'icon button without a name', state: el('button-name: buttons need an accessible name', '<button onClick={close}><XIcon /></button>'), expect: { a11y_violation: 'yes' } },
    { name: 'button with text on the next line', state: el('button-name: buttons need an accessible name', '<button onClick={save}>', [], ['  Save changes', '</button>']), expect: { a11y_violation: 'no' } },
    { name: 'clickable div without role', state: el('click-events-have-key-events: clickable non-interactive elements need a role and keyboard handling', '<div className="card" onClick={() => open(item.id)}>'), expect: { a11y_violation: 'yes' } },
    { name: 'input inside a label', state: el('label: form fields need a label', '  <input type="email" name="email" />', ['<label>', '  Email'], ['</label>']), expect: { a11y_violation: 'no' } },
    { name: 'input with only a placeholder', state: el('label: form fields need a label', '<input type="text" placeholder="Search" onChange={onSearch} />'), expect: { a11y_violation: 'yes' } },
    {
      name: 'effect reads a prop it does not list',
      state: hook('useEffect(() => {\n  fetchResults(query).then(setResults);\n}, []);'),
      expect: { omits_dependency: 'yes' },
    },
    {
      name: 'effect lists what it reads',
      state: hook('useEffect(() => {\n  fetchResults(query).then(setResults);\n}, [query]);'),
      expect: { omits_dependency: 'no' },
    },
    {
      name: 'memo over module constants and locals only',
      state: hook('const columns = useMemo(() => {\n  const base = DEFAULT_COLUMNS.slice();\n  return base.sort(byName);\n}, []);'),
      expect: { omits_dependency: 'no' },
    },
    {
      name: 'callback reads state it leaves out',
      state: hook('const submit = useCallback(() => {\n  api.save({ draft, userId });\n}, [userId]);'),
      expect: { omits_dependency: 'yes' },
    },
    { name: 'scroll area with no height bound', state: at('<div className="overflow-y-auto">', ['<section>'], ['  {messages.map(renderMessage)}', '</div>']), expect: { overflow_problem: 'yes' } },
    { name: 'scroll area with max height', state: at('<div className="max-h-96 overflow-y-auto">', ['<section>'], ['  {messages.map(renderMessage)}']), expect: { overflow_problem: 'no' } },
    { name: 'fixed height list cut off with no scrolling', state: at('<ul className="h-40 overflow-hidden">', ['<h2>All comments</h2>'], ['  {comments.map((c) => <li key={c.id}>{c.text}</li>)}', '</ul>']), expect: { overflow_problem: 'yes' } },
    { name: 'hidden overflow on a rounded avatar', state: at('<div className="rounded-full overflow-hidden w-10 h-10">', [], ['  <img src={user.avatar} alt="" />']), expect: { overflow_problem: 'no' } },
    { name: 'wide fixed content width', state: at('<main className="w-[1200px] mx-auto">'), expect: { fixed_size_problem: 'yes' } },
    { name: 'fixed width with a small breakpoint override', state: at('<aside className="w-full md:w-80">'), expect: { fixed_size_problem: 'no' } },
    { name: 'icon size', state: at('<SearchIcon className="w-5 h-5 text-gray-500" />'), expect: { fixed_size_problem: 'no' } },
    { name: 'css fixed width on a table wrapper', state: at("  width: 960px;", ['.report-table {'], ['  margin: 0 auto;', '}']), expect: { fixed_size_problem: 'yes' } },
    { name: 'next headers', state: { module: 'next/headers' }, expect: { server_only: 'yes' } },
    { name: 'server-only package', state: { module: 'server-only' }, expect: { server_only: 'yes' } },
    { name: 'node fs', state: { module: 'node:fs/promises' }, expect: { server_only: 'yes' } },
    { name: 'postgres driver', state: { module: 'pg' }, expect: { server_only: 'yes' } },
    { name: 'react', state: { module: 'react' }, expect: { server_only: 'no' } },
    { name: 'next link', state: { module: 'next/link' }, expect: { server_only: 'no' } },
    { name: 'date library', state: { module: 'date-fns' }, expect: { server_only: 'no' } },
    { name: 'modal overlay and toast share z-50', state: stack('src/app/page.tsx', 'z-50', MODAL_AND_TOAST, [4, 7]), expect: { stacking_conflict: 'yes' } },
    { name: 'sticky header and dropdown share z-index 100', state: stack('src/styles/layout.css', 'z-index: 100', HEADER_AND_DROPDOWN, [4, 10]), expect: { stacking_conflict: 'yes' } },
    { name: 'mobile or desktop navigation, never both', state: stack('src/components/Navigation.tsx', 'z-30', MOBILE_OR_DESKTOP_NAV, [3, 5]), expect: { stacking_conflict: 'no' } },
    { name: 'sticky bars on two different pages', state: stack('src/app/shared.tsx', 'z-20', TWO_ROUTES, [3, 7]), expect: { stacking_conflict: 'no' } },
  ],
});
