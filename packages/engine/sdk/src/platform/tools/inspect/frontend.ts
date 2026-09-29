import type {
  ComponentInfo,
  LayoutInfo,
  A11yIssue,
  ComponentStateInfo,
  StateVar,
  RenderTriggersInfo,
  RenderTrigger,
  HooksInfo,
  HookDep,
  OverflowInfo,
  OverflowIssue,
  SizingInfo,
  SizingItem,
  ResponsiveInfo,
  BreakpointUsage,
  EventsInfo,
  EventHandler,
  TailwindInfo,
  TailwindConflict,
  ClientBoundaryInfo,
  ErrorBoundaryInfo,
} from './schema.js';

export { inspectAccessibility, inspectClientBoundary, inspectHooks, inspectOverflow, inspectSizing, inspectStacking } from './frontend-readings.js';

export function inspectComponents(content: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const lines = content.split('\n');

  const FN_COMP_RE = /^(?:export\s+(?:default\s+)?)?function\s+(\w+)\s*\(/;
  const ARROW_COMP_RE = /^(?:export\s+(?:const|default)\s+)(\w+)\s*(?::\s*React\.FC[^=]*)?=\s*(?:(?:\([^)]*\)|\w+)\s*=>|React\.memo)/;
  const CLASS_COMP_RE = /^(?:export\s+(?:default\s+)?)?class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/;
  const HOOK_RE = /\b(use[A-Z]\w*)\s*\(/g;
  const CHILD_COMP_RE = /<([A-Z]\w*)(?:\s|>|\/)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let name: string | null = null;
    let kind: ComponentInfo['kind'] = 'function';

    let fnMatch = FN_COMP_RE.exec(line);
    if (fnMatch) {
      name = fnMatch[1]!;
      kind = 'function';
    }

    if (!name) {
      const arrowMatch = ARROW_COMP_RE.exec(line);
      if (arrowMatch) {
        name = arrowMatch[1]!;
        kind = 'arrow';
      }
    }

    if (!name) {
      const classMatch = CLASS_COMP_RE.exec(line);
      if (classMatch) {
        name = classMatch[1]!;
        kind = 'class';
      }
    }

    if (!name || !/^[A-Z]/.test(name)) continue;

    let body = '';
    const end = Math.min(i + 50, lines.length);
    for (let j = i; j < end; j++) body += lines[j]! + '\n';

    const hooks: string[] = [];
    const hooksSeen = new Set<string>();
    let hm: RegExpExecArray | null;
    const hookRe = new RegExp(HOOK_RE.source, 'g');
    while ((hm = hookRe.exec(body)) !== null) {
      if (!hooksSeen.has(hm[1]!)) {
        hooksSeen.add(hm[1]!);
        hooks.push(hm[1]!);
      }
    }

    const children: string[] = [];
    const childSeen = new Set<string>();
    let cm: RegExpExecArray | null;
    const childRe = new RegExp(CHILD_COMP_RE.source, 'g');
    while ((cm = childRe.exec(body)) !== null) {
      if (!childSeen.has(cm[1]!) && cm[1]! !== name) {
        childSeen.add(cm[1]!);
        children.push(cm[1]!);
      }
    }

    const props: string[] = [];
    const propLine = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
    const PROPS_DESTRUCTURE_RE = /\{\s*([^}]+)\s*\}/;
    const pm = PROPS_DESTRUCTURE_RE.exec(propLine);
    if (pm) {
      props.push(
        ...pm[1]!
          .split(',')
          .map((p) => p.trim().replace(/[=:][^,]*/g, '').trim())
          .filter((p) => /^\w+$/.test(p)),
      );
    }

    components.push({ name, kind, line: i + 1, props, hooks, children });
  }

  return components;
}

export function inspectLayout(content: string, file: string): LayoutInfo {
  const displays: string[] = [];
  const flex: string[] = [];
  const grid: string[] = [];
  const sizing: string[] = [];
  const overflow: string[] = [];

  const DISPLAY_RE = /\b(flex|grid|block|inline|inline-flex|inline-grid|inline-block|hidden|contents|flow-root)\b/g;
  const FLEX_RE = /\b(flex-(?:row|col|wrap|nowrap|1|auto|none|grow|shrink)|justify-(?:start|end|center|between|around|evenly)|items-(?:start|end|center|stretch|baseline)|gap-\w+|space-[xy]-\w+|self-\w+)\b/g;
  const GRID_RE = /\b(grid-cols-\w+|grid-rows-\w+|col-span-\w+|row-span-\w+|place-\w+-\w+)\b/g;
  const SIZING_RE = /\b(w-\w+|h-\w+|min-w-\w+|min-h-\w+|max-w-\w+|max-h-\w+|size-\w+)\b/g;
  const OVERFLOW_RE = /\b(overflow-(?:hidden|auto|scroll|visible|x-\w+|y-\w+)|truncate|text-ellipsis|whitespace-\w+)\b/g;

  const extract = (re: RegExp, target: string[]): void => {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(content)) !== null) {
      if (!seen.has(m[1]!)) {
        seen.add(m[1]!);
        target.push(m[1]!);
      }
    }
  };

  extract(DISPLAY_RE, displays);
  extract(FLEX_RE, flex);
  extract(GRID_RE, grid);
  extract(SIZING_RE, sizing);
  extract(OVERFLOW_RE, overflow);

  return { file, displays, flex, grid, sizing, overflow };
}

export function inspectComponentState(content: string, file: string): ComponentStateInfo {
  const lines = content.split('\n');
  const stateVars: StateVar[] = [];
  const useStateRe = /const\s*\[\s*(\w+)\s*,/;
  const useContextRe = /(?:const|let|var)\s+(\w+)\s*=\s*useContext\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    if (/\buseState\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1]! : '(unknown)', kind: 'useState', line: ln });
    } else if (/\buseReducer\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1]! : '(unknown)', kind: 'useReducer', line: ln });
    } else if (/\buseContext\s*\(/.test(line)) {
      const m = useContextRe.exec(line);
      stateVars.push({ name: m ? m[1]! : '(unknown)', kind: 'useContext', line: ln });
    }
  }
  return { file, stateVars, count: stateVars.length };
}

export function inspectRenderTriggers(content: string, file: string): RenderTriggersInfo {
  const lines = content.split('\n');
  const triggers: RenderTrigger[] = [];
  const setterRe = /const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    if (setterRe.test(line)) {
      const m = setterRe.exec(line);
      if (m) triggers.push({ kind: 'state_setter', name: m[1]!, line: ln });
    }
    if (/\buseEffect\s*\(/.test(line)) triggers.push({ kind: 'effect_dep', name: 'useEffect', line: ln });
    if (/\buseMemo\s*\(/.test(line)) triggers.push({ kind: 'memo_dep', name: 'useMemo', line: ln });
    if (/\buseCallback\s*\(/.test(line)) triggers.push({ kind: 'callback_dep', name: 'useCallback', line: ln });
    if (/(?:React\.memo|\bmemo)\s*\(/.test(line)) triggers.push({ kind: 'memo_boundary', name: 'memo', line: ln });
  }
  return { file, triggers, count: triggers.length };
}

export function inspectResponsive(content: string, file: string): ResponsiveInfo {
  const lines = content.split('\n');
  const prefixes = ['sm', 'md', 'lg', 'xl', '2xl'] as const;
  const breakpointMap = new Map<string, string[]>();
  for (const p of prefixes) breakpointMap.set(p, []);
  const re = /\b(sm|md|lg|xl|2xl):([-\w/[\]]+)/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const arr = breakpointMap.get(m[1]!)!;
      arr.push(m[0]);
    }
  }
  const breakpoints: BreakpointUsage[] = [];
  for (const p of prefixes) {
    const classes = breakpointMap.get(p)!;
    if (classes.length) breakpoints.push({ prefix: p, count: classes.length, classes: [...new Set(classes)].slice(0, 20) });
  }
  // Tailwind is mobile-first: unprefixed utilities target small screens and
  // breakpoint prefixes add min-width overrides. max-* variants style
  // downward from a breakpoint, the desktop-first form.
  const usesDesktopFirst = /(?:^|[\s"'`])max-(?:sm|md|lg|xl|2xl):/.test(content);
  return { file, breakpoints, hasMobileFirst: breakpoints.length > 0 && !usesDesktopFirst };
}

export function inspectEvents(content: string, file: string): EventsInfo {
  const lines = content.split('\n');
  const handlers: EventHandler[] = [];
  const eventRe = /\bon(Click|Change|Submit|KeyDown|KeyUp|KeyPress|Focus|Blur|MouseEnter|MouseLeave|Input|Scroll|Resize)\s*[={]/gi;
  const preventDefaultRe = /\.preventDefault\s*\(/;
  const stopPropagationRe = /\.stopPropagation\s*\(/;
  const delegationRe = /(?:document|window)\s*\.\s*addEventListener\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    eventRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = eventRe.exec(line)) !== null) {
      const ln = i + 1;
      const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join('\n');
      handlers.push({
        line: ln,
        event: m[0].slice(0, -1).trim(),
        hasPreventDefault: preventDefaultRe.test(ctx),
        hasStopPropagation: stopPropagationRe.test(ctx),
        isDelegated: delegationRe.test(line),
      });
    }
  }
  return { file, handlers, count: handlers.length };
}

export function inspectTailwind(content: string, file: string): TailwindInfo {
  const lines = content.split('\n');
  const conflicts: TailwindConflict[] = [];
  const conflictGroups: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /\bp-(\d+|px|py|\w+)\b/g, name: 'padding' },
    { pattern: /\bm-(\d+|px|py|auto|\w+)\b/g, name: 'margin' },
    { pattern: /\btext-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)\b/g, name: 'text-color' },
    { pattern: /\bbg-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)?\b/g, name: 'background' },
    { pattern: /\b(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|contents|flow-root|list-item)\b/g, name: 'display' },
    { pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g, name: 'font-size' },
    { pattern: /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g, name: 'font-weight' },
    { pattern: /\bjustify-(start|end|center|between|around|evenly|stretch)\b/g, name: 'justify-content' },
    { pattern: /\bitems-(start|end|center|baseline|stretch)\b/g, name: 'align-items' },
    { pattern: /\bw-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'width' },
    { pattern: /\bh-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'height' },
  ];
  // Two utilities of one group on the same element with no variant prefix set
  // the same CSS property (Tailwind's rule); a prefixed utility such as
  // md:flex applies at another state or size and does not conflict.
  const classNameRe = /className\s*=\s*["']([^"']+)["']/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let cm: RegExpExecArray | null;
    classNameRe.lastIndex = 0;
    while ((cm = classNameRe.exec(line)) !== null) {
      const tokens = cm[1]!.split(/\s+/).filter((token) => token.length > 0 && !token.includes(':'));
      for (const { pattern, name } of conflictGroups) {
        const whole = new RegExp(`^(?:${pattern.source.replace(/^\\b|\\b$/g, '')})$`);
        const found = tokens.filter((token) => whole.test(token));
        if (found.length > 1) {
          conflicts.push({ line: i + 1, classes: found, reason: `Multiple ${name} classes: ${found.join(', ')}` });
        }
      }
    }
  }
  return { file, conflicts, count: conflicts.length };
}

/**
 * Error boundaries by React's definition: a class component that defines
 * static getDerivedStateFromError or componentDidCatch, the ErrorBoundary
 * component imported from react-error-boundary, or a Next.js App Router
 * error file. A component is not a boundary because of its name.
 */
export function inspectErrorBoundary(content: string, file: string): ErrorBoundaryInfo {
  const boundaryComponents: string[] = [];
  const classRe = /class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)\b/g;
  const classes = [...content.matchAll(classRe)];
  classes.forEach((match, index) => {
    const body = content.slice(match.index!, classes[index + 1]?.index ?? content.length);
    if (/\bstatic\s+getDerivedStateFromError\s*\(|\bcomponentDidCatch\s*\(/.test(body)) boundaryComponents.push(match[1]!);
  });
  const libraryImport = /import\s*\{([^}]*)\}\s*from\s*['"]react-error-boundary['"]/.exec(content);
  for (const spec of libraryImport?.[1]?.split(',') ?? []) {
    const [imported, local] = spec.trim().split(/\s+as\s+/);
    if (imported === 'ErrorBoundary') boundaryComponents.push((local ?? imported).trim());
  }
  if (/(?:^|[\/\\])(?:global-)?error\.[jt]sx?$/.test(file)) boundaryComponents.push('error.tsx (Next.js App Router)');
  const coveredRoutes: string[] = [];
  for (const name of boundaryComponents.filter((component) => /^\w+$/.test(component))) {
    const wrappedRe = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'g');
    for (const wrapped of content.matchAll(wrappedRe)) {
      const child = /<(\w+)/.exec(wrapped[1] ?? '')?.[1];
      if (child && !coveredRoutes.includes(child)) coveredRoutes.push(child);
    }
  }
  return { file, hasErrorBoundary: boundaryComponents.length > 0, boundaryComponents, coveredRoutes };
}
