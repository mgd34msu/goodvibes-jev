import { randomUUID } from 'node:crypto';
import type { SgNode } from '@ast-grep/napi';

/** File-backed equivalent of Bun's printed evaluation, including statement
 * completions, imports, TypeScript and top-level await. Function/class bodies
 * belong to their own execution and must not change the snippet's completion. */
export async function capturedReplScript(source: string, bindings: string): Promise<string> {
  const { ts } = await import('@ast-grep/napi');
  const prefix = `__gv_${randomUUID().replaceAll('-', '')}`;
  const value = `${prefix}_value`, print = `${prefix}_print`;
  const edits: { start: number; end: number; text: string }[] = [];
  const insert = (at: number, text: string) => edits.push({ start: at, end: at, text });
  const containers = new Set(['program', 'statement_block', 'else_clause', 'switch_body', 'switch_case', 'switch_default']);
  const resets = new Set(['if_statement', 'switch_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'try_statement', 'with_statement', 'labeled_statement']);
  const visit = (node: SgNode, labeled = false): void => {
    const kind = String(node.kind()), range = node.range();
    if (kind === 'expression_statement') {
      const expression = node.children().find(child => child.isNamed() && child.kind() !== 'comment');
      if (expression) {
        const span = expression.range();
        insert(span.start.index, `${value} = (`);
        insert(span.end.index, ')');
      }
      return;
    }
    if (kind === 'finally_clause') {
      const block = node.children().find(child => child.kind() === 'statement_block');
      if (!block) return;
      const saved = `${prefix}_saved_${range.start.index}`;
      insert(block.range().start.index + 1, `const ${saved} = ${value};`);
      visit(block);
      // Normal finally completion is ignored; an abrupt break/continue/throw
      // skips this restore and supplies its own completion instead.
      insert(block.range().end.index - 1, `\n${value} = ${saved};`);
      return;
    }
    if (kind === 'catch_clause') {
      const block = node.children().find(child => child.kind() === 'statement_block');
      if (block) { insert(block.range().start.index + 1, `${value} = undefined;`); visit(block); }
      return;
    }
    if (!containers.has(kind) && !resets.has(kind)) return;
    // Wrap the whole label, preserving labeled continue targets.
    if (resets.has(kind) && !labeled) {
      insert(range.start.index, `{${value} = undefined;`);
    }
    for (const child of node.children()) if (child.isNamed()) visit(child, kind === 'labeled_statement');
    if (resets.has(kind) && !labeled) insert(range.end.index, '}');
  };
  visit(ts.parse(source).root());
  edits.sort((a, b) => a.start - b.start);
  let offset = 0, body = '';
  for (const edit of edits) { body += source.slice(offset, edit.start) + edit.text; offset = edit.end; }
  body += source.slice(offset);
  return `import { log as ${print} } from 'node:console';\nlet ${value};\nObject.defineProperties(globalThis, Object.fromEntries(Object.entries(JSON.parse(${JSON.stringify(bindings)})).map(([key, value]) => [key, {value, configurable: true, writable: true}])));\n${body}\n${print}(${value});\n`;
}
