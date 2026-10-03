'use strict';

// GoodVibes GHSA-vfj7-8cjw-p6xm: all recursive walkers share one finite
// limit, also enforced while parsing braces AND parenthesis groups.
const MAX_AST_DEPTH = 128;
const assertDepth = depth => {
  if (depth > MAX_AST_DEPTH) {
    throw new SyntaxError(`Input nesting exceeds maximum AST depth (${MAX_AST_DEPTH})`);
  }
};

const assertSafeAst = ast => {
  const active = new Set();
  const pending = [{ node: ast, depth: 0, exit: false }];
  while (pending.length > 0) {
    const { node, depth, exit } = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (exit) {
      active.delete(node);
      continue;
    }
    assertDepth(depth);
    if (active.has(node)) throw new SyntaxError('Cyclic brace AST');
    active.add(node);
    pending.push({ node, depth, exit: true });
    if (Array.isArray(node.nodes)) {
      for (let index = node.nodes.length - 1; index >= 0; index--) {
        pending.push({ node: node.nodes[index], depth: depth + 1, exit: false });
      }
    }
  }
};

module.exports = { MAX_AST_DEPTH, assertDepth, assertSafeAst };
