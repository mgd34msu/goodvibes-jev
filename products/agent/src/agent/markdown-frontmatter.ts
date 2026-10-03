/**
 * Shared YAML-style frontmatter parser for agent markdown files.
 *
 * Parses the `---\nkey: value\n---` block at the top of a markdown file
 * and optionally strips it from the body.
 */

/**
 * Parse the frontmatter block from a markdown string.
 * Returns a flat record of string key/value pairs.
 * Keys inside the block that have no value component are ignored.
 */
export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) result[key.trim()] = rest.join(':').trim();
  }
  return result;
}

/**
 * Strip the leading frontmatter block from a markdown string and return the body.
 * Trims the result unless `trim` is false.
 */
export function stripMarkdownFrontmatter(content: string, trim = true): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return trim ? body.trim() : body;
}
