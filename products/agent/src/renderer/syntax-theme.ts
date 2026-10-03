/**
 * syntax-theme.ts, the one role -> colour map for code.
 *
 * The agent's code-block tokenizers (code-block.ts) resolve through here, the
 * same role map the TUI's tree-sitter and regex paths use, so code follows the
 * active theme and reads the same on both surfaces.
 */

import { activeTokens, type PaletteTokens } from './theme.ts';

/** A syntax colour role. `plain` is text with no specific role. */
export type SyntaxRole =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'operator'
  | 'property'
  | 'builtin'
  | 'plain';

export interface SyntaxStyle {
  readonly fg: string;
  readonly italic?: boolean;
}

const stylesByPalette = new WeakMap<PaletteTokens, Readonly<Record<SyntaxRole, SyntaxStyle>>>();

/** Role styles for a token table (memoized per table; defaults to the active theme). */
export function syntaxStyles(tokens: Readonly<PaletteTokens> = activeTokens()): Readonly<Record<SyntaxRole, SyntaxStyle>> {
  const cached = stylesByPalette.get(tokens);
  if (cached !== undefined) return cached;
  const styles: Record<SyntaxRole, SyntaxStyle> = {
    keyword: { fg: tokens.syntaxKeyword },
    string: { fg: tokens.syntaxString },
    number: { fg: tokens.syntaxNumber },
    comment: { fg: tokens.syntaxComment, italic: true },
    function: { fg: tokens.syntaxFunction },
    type: { fg: tokens.syntaxType },
    operator: { fg: tokens.syntaxOperator },
    property: { fg: tokens.syntaxProperty },
    builtin: { fg: tokens.syntaxBuiltin },
    plain: { fg: tokens.text },
  };
  Object.freeze(styles);
  stylesByPalette.set(tokens, styles);
  return styles;
}
