/** A packaging declaration, never an authorization or a PATH fallback.
 * Linux compiled Bun entrypoints live in the runtime's fixed /$bunfs/ tree.
 * Their build owns a sibling ordinary-Bun executable; a missing sibling must
 * remain unavailable rather than invoke the product binary as an interpreter.
 */
export function resolveProcessCapturedBunRuntimeExecutable(): string {
  const compiled = process.platform === 'linux' && typeof Bun !== 'undefined' && Bun.main.startsWith('/$bunfs/');
  return compiled ? `${process.execPath}.bun` : process.execPath;
}
